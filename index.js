const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================================
// ⚙️ MIDDLEWARE SETUP
// ==========================================
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://biblio-drop-a10.vercel.app"
  ],
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"]
}));
app.use(cookieParser());
app.use(express.json());

// ==========================================
// 🗄️ DATABASE CONNECTION & CACHING
// ==========================================
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
let cachedClient = null;
let cachedDb = null;

let subscriptionCollection,
    userCollection,
    booksCollection,
    paymentCollection,
    deliveryCollection,
    reviewCollection,
    sessionCollection;

async function dbConnect() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  const client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    }
  });

  await client.connect();
  const db = client.db("biblio-drop_db");

  subscriptionCollection = db.collection("subscription");
  userCollection = db.collection("user");
  booksCollection = db.collection("books");
  paymentCollection = db.collection("payment");
  deliveryCollection = db.collection("deliveries");
  reviewCollection = db.collection("reviews");
  sessionCollection = db.collection("session");

  try {
    await sessionCollection.createIndex({ token: 1 });
    await booksCollection.createIndex({ userId: 1, createdAt: -1 });
    await booksCollection.createIndex({ status: 1 });
  } catch (idxErr) {
    console.warn("Index warning:", idxErr.message);
  }

  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

// Global DB Middleware
app.use(async (req, res, next) => {
  try {
    await dbConnect();
    next();
  } catch (err) {
    console.error("MongoDB Connection Error:", err);
    res.status(500).json({ error: "Database Connection Error" });
  }
});

// ==========================================
// 🔐 AUTH & GATEKEEPER MIDDLEWARES (FIXED FOR VERCEL)
// ==========================================
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    let rawToken = (authHeader && authHeader.split(" ")[1]) || 
                   req.cookies['__Secure-better-auth.session_token'] || 
                   req.cookies['better-auth.session_token'];

    if (!rawToken && req.headers.cookie) {
      const cookies = req.headers.cookie.split(';').reduce((acc, cookie) => {
        const parts = cookie.trim().split('=');
        const key = parts[0];
        const value = parts.slice(1).join('=');
        acc[key] = value ? value.trim() : '';
        return acc;
      }, {});
      rawToken = cookies['better-auth.session_token'] || cookies['__Secure-better-auth.session_token'];
    }

    if (!rawToken) {
      return res.status(401).json({ msg: "No token found" });
    }

    const sessionToken = rawToken.includes('.') ? rawToken.split('.')[0] : rawToken; 
    let session = await sessionCollection.findOne({ token: sessionToken });

    if (!session) {
      session = await sessionCollection.findOne({ token: rawToken });
    }

    if (!session) {
      return res.status(401).json({ msg: "Invalid Session" });
    }

    const userIdVal = session.userId || session.user?.id;
    if (!userIdVal || !ObjectId.isValid(userIdVal)) {
      return res.status(401).json({ msg: "Invalid User ID format" });
    }

    const user = await userCollection.findOne({ _id: new ObjectId(userIdVal) });
    if (!user) {
      return res.status(401).json({ msg: "User not found" });
    }

    req.user = { ...user, id: user._id.toString() };
    next();
  } catch (err) {
    console.error("verifyToken error:", err);
    res.status(500).json({ msg: "Server Error" });
  }
};

const isAdmin = (req, res, next) => {
  const userRole = (req.user?.role || '').toLowerCase();
  if (userRole === 'admin') {
    next();
  } else {
    return res.status(403).json({ msg: "Forbidden: Admins only" });
  }
};

app.get('/', (req, res) => res.json({ message: 'BiblioDrop Server is running!' }));

// ==========================================
// 💳 STRIPE PAYMENTS
// ==========================================

app.post("/api/create-checkout-session", verifyToken, async (req, res) => {
  try {
    const { bookId } = req.body;
    if (!ObjectId.isValid(bookId)) return res.status(400).json({ error: "Invalid Book ID" });

    const book = await booksCollection.findOne({ _id: new ObjectId(bookId) });
    if (!book) return res.status(404).json({ error: "Book not found" });

    const feeAmount = Math.max(Number(book.deliveryFee || 5) * 100, 50);
    const clientUrl = process.env.NODE_ENV === 'production' 
      ? "https://biblio-drop-a10.vercel.app" 
      : "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Delivery Fee: ${book.title}`,
            description: `Delivery fee for borrowing "${book.title}"`,
          },
          unit_amount: feeAmount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${clientUrl}/dashboard/user?payment_success=true&bookId=${bookId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/browse-books/${bookId}?canceled=true`,
      metadata: {
        userId: req.user.id,
        userEmail: req.user.email,
        bookId: book._id.toString(),
        librarianId: book.userId ? book.userId.toString() : '',
        bookTitle: book.title,
        deliveryFee: book.deliveryFee || 5
      }
    });

    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error("Stripe Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/payments/confirm", verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === 'paid') {
      const { userId, userEmail, bookId, librarianId, bookTitle, deliveryFee } = session.metadata || {};

      const existingPayment = await paymentCollection.findOne({ transactionId: session.payment_intent });
      if (existingPayment) {
        return res.json({ success: true, message: "Already processed" });
      }

      await paymentCollection.insertOne({
        transactionId: session.payment_intent,
        userId: new ObjectId(userId),
        userEmail,
        amount: Number(deliveryFee),
        date: new Date(),
        createdAt: new Date()
      });

      await deliveryCollection.insertOne({
        bookId: new ObjectId(bookId),
        userId: new ObjectId(userId),
        userEmail,
        librarianId: librarianId ? (ObjectId.isValid(librarianId) ? new ObjectId(librarianId) : librarianId) : null,
        title: bookTitle,
        deliveryFee: Number(deliveryFee),
        status: "Pending",
        requestedAt: new Date()
      });

      return res.json({ success: true, message: "Payment & Delivery request created successfully" });
    }

    res.status(400).json({ error: "Payment not completed" });
  } catch (err) {
    console.error("Payment Confirmation Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

// ==========================================
// 📚 PUBLIC BOOKS API
// ==========================================

app.get("/books", async (req, res) => {
  try {
    const { search = "", category, availability, minFee, maxFee, page = 1, limit = 6 } = req.query;

    const query = { 
      status: { $in: ["Approved", "Published", "approved", "published"] } 
    };

    if (search) query.title = { $regex: search, $options: "i" };
    if (category && category !== "All") query.category = category;
    if (availability && availability !== "All") query.availability = availability;

    if (minFee || maxFee) {
      query.deliveryFee = {};
      if (minFee) query.deliveryFee.$gte = Number(minFee);
      if (maxFee) query.deliveryFee.$lte = Number(maxFee);
    }

    const currentPage = Math.max(1, Number(page));
    const perPage = Math.max(1, Number(limit));

    const totalBooks = await booksCollection.countDocuments(query);
    const books = await booksCollection
      .find(query)
      .skip((currentPage - 1) * perPage)
      .limit(perPage)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      books,
      totalBooks,
      currentPage,
      totalPages: Math.ceil(totalBooks / perPage) || 1,
    });
  } catch (error) {
    console.error("Error in /books:", error);
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/books/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

    const result = await booksCollection.findOne({ _id: new ObjectId(id) });
    if (!result) return res.status(404).json({ error: "Book not found" });

    res.json(result);
  } catch (error) { 
    res.status(500).json({ error: "Server Error" }); 
  }
});

// ==========================================
// 🧑‍💼 LIBRARIAN DASHBOARD API
// ==========================================

app.get("/api/librarian/stats", verifyToken, async (req, res) => {
  try {
    const userIdStr = req.user.id ? req.user.id.toString() : "";
    const query = {
      $or: [
        { userId: userIdStr },
        { userId: ObjectId.isValid(userIdStr) ? new ObjectId(userIdStr) : null },
        { userEmail: req.user.email },
        { addedBy: req.user.email }
      ].filter(Boolean)
    };

    const myBooks = await booksCollection.countDocuments(query);
    const approvedBooks = await booksCollection.countDocuments({ 
      ...query, 
      status: { $in: ["Approved", "Published", "approved", "published"] } 
    });
    
    const deliveryQuery = {
      $or: [
        { librarianId: userIdStr },
        { librarianId: ObjectId.isValid(userIdStr) ? new ObjectId(userIdStr) : null }
      ].filter(Boolean)
    };

    const pendingRequests = await deliveryCollection.countDocuments({
      ...deliveryQuery,
      status: "Pending"
    });

    const earningsAgg = await deliveryCollection.aggregate([
      { $match: { ...deliveryQuery, status: "Delivered" } },
      { $group: { _id: null, total: { $sum: "$deliveryFee" } } }
    ]).toArray();

    const totalEarnings = earningsAgg[0]?.total || 0;

    res.json({
      myBooks,
      pendingRequests,
      approvedBooks,
      totalEarnings
    });
  } catch (err) {
    console.error("Error in /api/librarian/stats:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.post("/api/books", verifyToken, async (req, res) => {
  try {
    const bookData = req.body;
    const userRole = (req.user?.role || '').toLowerCase();

    const initialStatus = userRole === 'admin' ? "Approved" : "Pending Approval";
    const initialIsApproved = userRole === 'admin';

    const newBook = {
      ...bookData,
      userId: req.user.id,
      userEmail: req.user.email,
      addedBy: req.user.email,
      status: bookData.status || initialStatus, 
      isApproved: initialIsApproved,
      createdAt: new Date()
    };

    const result = await booksCollection.insertOne(newBook);
    res.status(201).json({ success: true, insertedId: result.insertedId });
  } catch (e) { 
    console.error("Add book error:", e);
    res.status(500).json({ error: "Server Error" }); 
  }
});

app.get("/api/librarian/books", verifyToken, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Number(req.query.limit) || 10);
    const search = req.query.search || "";
    const userIdStr = req.user.id ? req.user.id.toString() : "";

    const query = {
      $or: [
        { userId: userIdStr },
        { userId: ObjectId.isValid(userIdStr) ? new ObjectId(userIdStr) : null },
        { userEmail: req.user.email },
        { addedBy: req.user.email }
      ].filter(Boolean)
    };

    if (search) query.title = { $regex: search, $options: "i" };

    const totalBooks = await booksCollection.countDocuments(query);
    const books = await booksCollection
      .find(query)
      .skip((page - 1) * limit)
      .limit(limit)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      books,
      currentPage: page,
      totalPages: Math.ceil(totalBooks / limit) || 1,
      totalBooks,
    });
  } catch (e) {
    console.error("Get librarian books error:", e);
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/librarian/books/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const updateData = { ...req.body };
    delete updateData._id;

    const result = await booksCollection.updateOne(
      { 
        _id: new ObjectId(id),
        $or: [{ userId: req.user.id }, { userEmail: req.user.email }] 
      },
      { $set: { ...updateData, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Book not found or unauthorized" });
    }

    res.json({ success: true, message: "Book updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.delete("/api/librarian/books/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const result = await booksCollection.deleteOne({
      _id: new ObjectId(id),
      $or: [{ userId: req.user.id }, { userEmail: req.user.email }]
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Book not found or unauthorized" });
    }

    res.json({ success: true, message: "Book deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.patch("/api/librarian/books/unpublish/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    await booksCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "Unpublished", isApproved: false } }
    );
    res.json({ success: true, message: "Book unpublished successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.get("/api/librarian/overview", verifyToken, async (req, res) => {
  try {
    const userIdStr = req.user.id ? req.user.id.toString() : "";
    const query = {
      $or: [
        { userId: userIdStr },
        { userId: ObjectId.isValid(userIdStr) ? new ObjectId(userIdStr) : null },
        { userEmail: req.user.email }
      ].filter(Boolean)
    };

    const myBooks = await booksCollection.countDocuments(query);
    const approvedBooks = await booksCollection.countDocuments({ ...query, status: { $in: ["Approved", "Published"] } });
    const pendingBooks = await booksCollection.countDocuments({ ...query, status: { $in: ["Pending Approval", "Pending", "pending"] } });
    const totalRequests = await deliveryCollection.countDocuments({
      $or: [
        { librarianId: userIdStr },
        { librarianId: ObjectId.isValid(userIdStr) ? new ObjectId(userIdStr) : null }
      ].filter(Boolean)
    });

    res.json({ myBooks, publishedBooks: approvedBooks, pendingBooks, totalRequests });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/librarian/deliveries", verifyToken, async (req, res) => {
  try {
    const userIdStr = req.user.id ? req.user.id.toString() : "";
    const deliveries = await deliveryCollection.find({
      $or: [
        { librarianId: userIdStr },
        { librarianId: ObjectId.isValid(userIdStr) ? new ObjectId(userIdStr) : null }
      ].filter(Boolean)
    }).sort({ requestedAt: -1 }).toArray();

    res.json(deliveries);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/librarian/deliveries/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const { status } = req.body;
    await deliveryCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==========================================
// 👤 USER DASHBOARD & REVIEWS API
// ==========================================

app.get("/api/user/summary", verifyToken, async (req, res) => {
  try {
    const userIdStr = req.user.id || req.user._id;
    if (!ObjectId.isValid(userIdStr)) {
      return res.status(400).json({ error: "Invalid User ID" });
    }
    const userId = new ObjectId(userIdStr);

    const totalOrders = await deliveryCollection.countDocuments({ userId });
    const pendingOrders = await deliveryCollection.countDocuments({ userId, status: "Pending" });
    
    const paymentAgg = await paymentCollection.aggregate([
      { $match: { userId } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]).toArray();

    const totalReviews = await reviewCollection.countDocuments({ userId });

    res.json({
      totalOrders,
      pendingOrders,
      totalSpent: paymentAgg[0]?.total || 0,
      totalReviews
    });
  } catch (err) {
    console.error("Error in /api/user/summary:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/user/borrowed-books", verifyToken, async (req, res) => {
  try {
    const userIdStr = req.user.id || req.user._id;
    if (!ObjectId.isValid(userIdStr)) return res.status(400).json({ error: "Invalid User ID" });
    const userId = new ObjectId(userIdStr);

    const borrowedBooks = await deliveryCollection
      .find({ userId })
      .sort({ requestedAt: -1 })
      .toArray();

    res.json(borrowedBooks);
  } catch (err) {
    console.error("Error fetching borrowed books:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/user/delivery-history", verifyToken, async (req, res) => {
  try {
    const userIdStr = req.user.id || req.user._id;
    if (!ObjectId.isValid(userIdStr)) return res.status(400).json({ error: "Invalid User ID" });

    const history = await deliveryCollection
      .find({ userId: new ObjectId(userIdStr) })
      .sort({ requestedAt: -1 })
      .toArray();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/user/transactions", verifyToken, async (req, res) => {
  try {
    const userIdStr = req.user.id || req.user._id;
    if (!ObjectId.isValid(userIdStr)) return res.status(400).json({ error: "Invalid User ID" });

    const payments = await paymentCollection
      .find({ userId: new ObjectId(userIdStr) })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/user/my-reviews", verifyToken, async (req, res) => {
  try {
    const userIdStr = req.user.id || req.user._id;
    if (!ObjectId.isValid(userIdStr)) return res.status(400).json({ error: "Invalid User ID" });

    const reviews = await reviewCollection
      .find({ userId: new ObjectId(userIdStr) })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.post("/api/reviews", verifyToken, async (req, res) => {
  try {
    const { bookId, rating, comment } = req.body;
    const userIdStr = req.user.id || req.user._id;
    if (!bookId || !rating || !comment || !ObjectId.isValid(bookId) || !ObjectId.isValid(userIdStr)) {
      return res.status(400).json({ success: false, message: "Missing or invalid required fields" });
    }

    const delivery = await deliveryCollection.findOne({
      userId: new ObjectId(userIdStr),
      bookId: new ObjectId(bookId),
      status: "Delivered",
    });

    if (!delivery) {
      return res.status(403).json({
        success: false,
        message: "You can only review books that have been Delivered to you.",
      });
    }

    const review = {
      bookId: new ObjectId(bookId),
      userId: new ObjectId(userIdStr),
      userName: req.user.name || "Anonymous",
      userPhoto: req.user.image || "",
      rating: Number(rating),
      comment,
      createdAt: new Date(),
    };

    await reviewCollection.insertOne(review);
    res.status(201).json({ success: true, message: "Review added successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.get("/api/reviews/:bookId", async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!ObjectId.isValid(bookId)) return res.status(400).json({ error: "Invalid Book ID" });

    const reviews = await reviewCollection
      .find({ bookId: new ObjectId(bookId) })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

// ==========================================
// 👑 ADMIN DASHBOARD API
// ==========================================

app.get("/api/admin/chart", verifyToken, isAdmin, async (req, res) => {
  try {
    const totalUsers = await userCollection.countDocuments();
    const totalBooks = await booksCollection.countDocuments();
    const pendingBooks = await booksCollection.countDocuments({ 
      $or: [{ status: "Pending Approval" }, { status: "Pending" }, { status: "pending" }] 
    });

    const revenueAgg = await paymentCollection.aggregate([
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]).toArray();

    const categoryStats = await booksCollection.aggregate([
      { $group: { _id: "$category", count: { $sum: 1 } } }
    ]).toArray();

    res.json({
      totalUsers,
      totalBooks,
      pendingBooks,
      totalRevenue: revenueAgg[0]?.total || 0,
      categoryStats
    });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/admin/books", verifyToken, isAdmin, async (req, res) => {
  try {
    const books = await booksCollection.find().sort({ createdAt: -1 }).toArray();
    res.json(books);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/admin/books/approve/:id", verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

    await booksCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "Approved", isApproved: true, approvedAt: new Date() } }
    );
    res.json({ success: true, message: "Book Approved and Published" });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/admin/books/reject/:id", verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

    await booksCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "Rejected", isApproved: false } }
    );
    res.json({ success: true, message: "Book Rejected" });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/admin/books/unpublish/:id", verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

    await booksCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "Unpublished", isApproved: false } }
    );
    res.json({ success: true, message: "Book Unpublished" });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.delete("/api/admin/books/:id", verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

    await booksCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Book deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/admin/users", verifyToken, isAdmin, async (req, res) => {
  try {
    const users = await userCollection.find().toArray();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/admin/users/:id", verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

    const { role } = req.body;
    await userCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.delete("/api/admin/users/:id", verifyToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

    await userCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/admin/transactions", verifyToken, isAdmin, async (req, res) => {
  try {
    const transactions = await paymentCollection.find().sort({ createdAt: -1 }).toArray();
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

// ==========================================
// 🚀 SERVER EXPORT & LISTEN
// ==========================================
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port: ${PORT}`));
}