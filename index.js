const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================================
// ⚙️ OPEN CORS & MIDDLEWARE SETUP
// ==========================================
app.use(cors({
  origin: true, // সব ডোমেইন এবং Vercel প্রিভিউ লিংক অ্যালাও করা হলো
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
// 🏠 ROOT ROUTE
// ==========================================
app.get("/", (req, res) => {
  res.send("Biblio Drop Server is running successfully without security barriers!");
});

// ==========================================
// 💳 STRIPE PAYMENTS
// ==========================================
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { bookId, userId, userEmail } = req.body;
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
        userId: userId || '',
        userEmail: userEmail || '',
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

app.post("/api/payments/confirm", async (req, res) => {
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
        userId: userId && ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
        userEmail,
        amount: Number(deliveryFee),
        date: new Date(),
        createdAt: new Date()
      });

      await deliveryCollection.insertOne({
        bookId: new ObjectId(bookId),
        userId: userId && ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
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
app.get("/api/librarian/stats", async (req, res) => {
  try {
    const myBooks = await booksCollection.countDocuments();
    const approvedBooks = await booksCollection.countDocuments({ 
      status: { $in: ["Approved", "Published", "approved", "published"] } 
    });
    
    const pendingRequests = await deliveryCollection.countDocuments({
      status: "Pending"
    });

    const earningsAgg = await deliveryCollection.aggregate([
      { $match: { status: "Delivered" } },
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

app.post("/api/books", async (req, res) => {
  try {
    const bookData = req.body;
    const newBook = {
      ...bookData,
      status: bookData.status || "Approved", 
      isApproved: true,
      createdAt: new Date()
    };

    const result = await booksCollection.insertOne(newBook);
    res.status(201).json({ success: true, insertedId: result.insertedId });
  } catch (e) { 
    console.error("Add book error:", e);
    res.status(500).json({ error: "Server Error" }); 
  }
});

app.get("/api/librarian/books", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Number(req.query.limit) || 10);
    const search = req.query.search || "";

    const query = {};
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

app.patch("/api/librarian/books/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const updateData = { ...req.body };
    delete updateData._id;

    await booksCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updateData, updatedAt: new Date() } }
    );

    res.json({ success: true, message: "Book updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.delete("/api/librarian/books/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    await booksCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Book deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.patch("/api/librarian/books/unpublish/:id", async (req, res) => {
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

app.get("/api/librarian/overview", async (req, res) => {
  try {
    const myBooks = await booksCollection.countDocuments();
    const approvedBooks = await booksCollection.countDocuments({ status: { $in: ["Approved", "Published"] } });
    const pendingBooks = await booksCollection.countDocuments({ status: { $in: ["Pending Approval", "Pending", "pending"] } });
    const totalRequests = await deliveryCollection.countDocuments();

    res.json({ myBooks, publishedBooks: approvedBooks, pendingBooks, totalRequests });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/librarian/deliveries", async (req, res) => {
  try {
    const deliveries = await deliveryCollection.find().sort({ requestedAt: -1 }).toArray();
    res.json(deliveries);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/librarian/deliveries/:id", async (req, res) => {
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
app.get("/api/user/summary", async (req, res) => {
  try {
    const totalOrders = await deliveryCollection.countDocuments();
    const pendingOrders = await deliveryCollection.countDocuments({ status: "Pending" });
    
    const paymentAgg = await paymentCollection.aggregate([
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]).toArray();

    const totalReviews = await reviewCollection.countDocuments();

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

app.get("/api/user/borrowed-books", async (req, res) => {
  try {
    const borrowedBooks = await deliveryCollection
      .find()
      .sort({ requestedAt: -1 })
      .toArray();

    res.json(borrowedBooks);
  } catch (err) {
    console.error("Error fetching borrowed books:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/user/delivery-history", async (req, res) => {
  try {
    const history = await deliveryCollection
      .find()
      .sort({ requestedAt: -1 })
      .toArray();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/user/transactions", async (req, res) => {
  try {
    const payments = await paymentCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/user/my-reviews", async (req, res) => {
  try {
    const reviews = await reviewCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.post("/api/reviews", async (req, res) => {
  try {
    const { bookId, rating, comment, userName, userPhoto } = req.body;
    if (!bookId || !rating || !comment || !ObjectId.isValid(bookId)) {
      return res.status(400).json({ success: false, message: "Missing or invalid required fields" });
    }

    const review = {
      bookId: new ObjectId(bookId),
      userName: userName || "Anonymous",
      userPhoto: userPhoto || "",
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
app.get("/api/admin/chart", async (req, res) => {
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

app.get("/api/admin/books", async (req, res) => {
  try {
    const books = await booksCollection.find().sort({ createdAt: -1 }).toArray();
    res.json(books);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/admin/books/approve/:id", async (req, res) => {
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

app.patch("/api/admin/books/reject/:id", async (req, res) => {
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

app.patch("/api/admin/books/unpublish/:id", async (req, res) => {
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

app.delete("/api/admin/books/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

    await booksCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Book deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/admin/users", async (req, res) => {
  try {
    const users = await userCollection.find().toArray();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/admin/users/:id", async (req, res) => {
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

app.delete("/api/admin/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

    await userCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/admin/transactions", async (req, res) => {
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