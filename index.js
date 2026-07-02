const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
require('dotenv').config();


const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://biblio-drop-a10.vercel.app" 
  ],
  credentials: true
}));
app.use(cookieParser());
app.use(express.json()); 

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');

// Database Setup
const uri = process.env.MONGODB_URI || process.env.MONGO_URI; 
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,  
    strict: true,
    deprecationErrors: true,
  }   
});   


const currentClientUrl = process.env.NODE_ENV === 'production' 
  ? "https://biblio-drop-a10.vercel.app" 
  : "http://localhost:3000";

const JWKS = createRemoteJWKSet(new URL(`${currentClientUrl}/api/auth/jwks`));

// Database Globals
let subscriptionCollection,
    userCollection,
    booksCollection,
    paymentCollection,
    deliveryCollection,
    reviewCollection;

async function dbConnect() {
  if (subscriptionCollection) return; 
  try {
    await client.connect();
    const db = client.db("biblio-drop_db"); 
    subscriptionCollection = db.collection("subscription");
    userCollection = db.collection("user"); 
    booksCollection = db.collection("books");
    paymentCollection = db.collection("payment");
    deliveryCollection = db.collection("deliveries");
reviewCollection = db.collection("reviews");
    console.log("MongoDB Connected!");
  } catch (err) {
    console.error("MongoDB Connection Error:", err);
  }
}

// Middleware: Verification 
const verifyToken = async (req, res, next) => {
  try {
    await dbConnect();

    // হেডার অথবা কুকি থেকে টোকেন নিন
    const authHeader = req.headers.authorization;
    let rawToken = (authHeader && authHeader.split(" ")[1]) || 
                   req.cookies['__Secure-better-auth.session_token'] || 
                   req.cookies['better-auth.session_token'];

    if (!rawToken) {
      return res.status(401).json({ msg: "No token found" });
    }

    const sessionToken = rawToken.split('.')[0]; 
    
    console.log("DEBUG: Checking Database for Token:", sessionToken);

    const session = await client.db("biblio-drop_db").collection("session").findOne({ token: sessionToken });

    if (!session) {
      console.log("DEBUG: No session found for token:", sessionToken);
      return res.status(401).json({ msg: "Invalid Session" });
    }

    const user = await client.db("biblio-drop_db").collection("user").findOne({ _id: new ObjectId(session.userId) });
    req.user = { ...user, id: user._id.toString() };
    next();
  } catch (err) {
    res.status(500).json({ msg: "Server Error" });
  }
};


// Base Route
app.get('/', (req, res) => res.json({ message: 'Server is running!' }));


// DASHBOARD SUMMARY API 
app.get("/api/dashboard-stats", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const userId = req.user.id; 
    const userRole = (req.user.role || '').toLowerCase();
    
    let stats = {};

    if (userRole === 'admin') {
      const revenue = await paymentCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
      stats = {
        totalUsers: await userCollection.countDocuments(),
        totalBooks: await booksCollection.countDocuments(),
        pendingBooks: await booksCollection.countDocuments({ status: "Pending" }),
        totalRevenue: revenue[0]?.total || 0
      };
    } 
    else if (userRole === 'librarian') {
    
      const query = { userId: userId }; 
      const queryObj = { userId: new ObjectId(userId) };

      
      const myBooks = await booksCollection.countDocuments(query);
      const myBooksObj = await booksCollection.countDocuments(queryObj);
      const actualMyBooks = myBooks > 0 ? myBooks : myBooksObj;

      stats = {
        myBooks: actualMyBooks,
        pendingRequests: await booksCollection.countDocuments({ ...query, status: "Pending" }),
        approvedBooks: await booksCollection.countDocuments({ ...query, status: "Approved" }),
        totalEarnings: 0
      };
    } 
    else {
      const spent = await paymentCollection.aggregate([{ $match: { userId: userId } }, { $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
      stats = {
        totalBorrowed: await booksCollection.countDocuments({ borrowerId: userId }),
        totalSpent: spent[0]?.total || 0
      };
    }
    
    console.log("DEBUG: Final Stats for Librarian:", stats);
    res.json(stats);
  } catch (e) {
    console.error("Dashboard Stats Error:", e);
    res.status(500).json({ error: "Server Error" });
  }
});


app.get("/api/librarian/overview", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const librarianId = req.user.id;
    const myBooks = await booksCollection.countDocuments({ userId: librarianId });
    const approvedBooks = await booksCollection.countDocuments({ userId: librarianId, status: "Approved" });
    const pendingBooks = await booksCollection.countDocuments({ userId: librarianId, status: "Pending" });
    const totalRequests = await deliveryCollection.countDocuments({ librarianId });

    res.json({
      myBooks,
      publishedBooks: approvedBooks, 
      pendingBooks,
      totalRequests
    });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

// GET DELIVERY HISTORY API
app.get("/api/user/delivery-history", verifyToken, async (req, res) => {
  await dbConnect();

  try {
    const history = await deliveryCollection
      .find({
        userId: new ObjectId(req.user._id),
      })
      .sort({
        requestedAt: -1,
      })
      .toArray();

    res.json(history);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Server Error",
    });
  }
});


app.get("/api/user/summary", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const userId = req.user._id.toString();

    const currentlyReading = await booksCollection.countDocuments({ borrowerId: userId, status: "Borrowed" });
    const totalBorrowed = await booksCollection.countDocuments({ borrowerId: userId });
    const wishlistCount = req.user.wishlist ? req.user.wishlist.length : 0; 

    res.json({ currentlyReading, totalBorrowed, wishlistCount });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});
//  SUBSCRIPTION & PAYMENT API

app.post("/subscription", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const { sessionid, userId } = req.body;
    await subscriptionCollection.insertOne({ sessionId: sessionid, userId, createdAt: new Date() });
    await userCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { plan: "user_pro" } });
    res.json({ msg: "Success" });
  } catch (e) { res.status(500).json({ error: "Server Error" }); }
});


const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    console.log("Access Denied for user:", req.user?.email);
    return res.status(403).json({ msg: "Forbidden: Admins only" });
  }
};

app.get("/api/admin/stats", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();
  try {
    const stats = {
      totalUsers: await userCollection.countDocuments(),
      totalBooks: await booksCollection.countDocuments(),
      pendingBooks: await booksCollection.countDocuments({ status: "Pending" }),
      totalRevenue: (await paymentCollection.aggregate([{ 
        $group: { _id: null, total: { $sum: "$amount" } } 
      }]).toArray())[0]?.total || 0
    };
    res.json(stats);
  } catch (e) { 
    console.error("Admin Stats Error:", e);
    res.status(500).json({ error: "Server Error" }); 
  }
});

app.patch("/api/admin/books/approve/:id", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  try {
    const result = await booksCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
  status: "Approved",
  approvedAt: new Date()
}
      }
    );

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "Server Error" });
  }
});


app.get("/api/admin/users", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  try {
    const users = await userCollection.find().toArray();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});


//  BOOKS API

app.get("/books", async (req, res) => {
  await dbConnect();

  try {
    const {
      search = "",
      category,
      availability,
      minFee,
      maxFee,
      page = 1,
      limit = 6,
    } = req.query;

    const query = {
      status: "Approved",
    };

    // Search by title
    if (search) {
      query.title = {
        $regex: search,
        $options: "i",
      };
    }

    // Category Filter
    if (category && category !== "All") {
      query.category = category;
    }

    // Availability Filter
    if (availability && availability !== "All") {
      query.availability = availability;
    }

    // Delivery Fee Filter
    if (minFee || maxFee) {
      query.deliveryFee = {};

      if (minFee) {
        query.deliveryFee.$gte = Number(minFee);
      }

      if (maxFee) {
        query.deliveryFee.$lte = Number(maxFee);
      }
    }

    const currentPage = Number(page);
    const perPage = Number(limit);

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
      totalPages: Math.ceil(totalBooks / perPage),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      error: "Server Error",
    });
  }
});


app.get("/books/:id", async (req, res) => {
  await dbConnect();
  try {
    const { id } = req.params;
    
    const result = await booksCollection.findOne({ _id: new ObjectId(id) });
    
    if (!result) {
      return res.status(404).json({ error: "Book not found" });
    }
    
    res.json(result);
  } catch (error) { 
    console.error("Error in GET /books/:id", error);
    res.status(500).json({ error: "Server Error" }); 
  }
});

app.post("/api/books", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const bookData = req.body;
    const newBook = {
      ...bookData,
      userId: new ObjectId(req.user._id),
      status: "Pending", 
      createdAt: new Date()
    };
    const result = await booksCollection.insertOne(newBook);
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: "Server Error" }); }
});



app.patch("/books/:id",verifyToken, async (req, res) => {
  const { id } = req.params;
  const updatedData = req.body;

  try {
    const result = await booksCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedData }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Book not found" });
    }
    
    res.json({ message: "Book updated successfully!", result });
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
});


app.delete("/books/:id",verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await booksCollection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Book not found" });
    }
    res.json({ message: "Book deleted successfully!" });
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
});

// ADMIN MANAGE USERS API

app.get("/api/users", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const users = await userCollection.find().toArray();
    res.json(users);
  } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

app.patch("/api/users/:id", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const { id } = req.params;
    const { role } = req.body;
    const result = await userCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

app.delete("/api/users/:id", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const { id } = req.params;
    const result = await userCollection.deleteOne({ _id: new ObjectId(id) });
    res.json(result);
  } catch (e) { res.status(500).json({ error: "Server Error" }); }
});



app.get("/api/librarian/books", verifyToken, async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 6;
    const search = req.query.search || "";

    // ইউজার আইডি দিয়ে কোয়েরি
    const query = { userId: req.user.id };

    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

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
      totalPages: Math.ceil(totalBooks / limit),
      totalBooks,
    });
  } catch (e) {
    console.error("API Error:", e);
    res.status(500).json({ error: "Server Error" });
  }
});


app.post("/api/deliveries", verifyToken, async (req, res) => {
  await dbConnect();

  try {
    const { bookId } = req.body;

    const book = await booksCollection.findOne({
      _id: new ObjectId(bookId),
    });

    if (!book) {
      return res.status(404).json({
        success: false,
        message: "Book not found",
      });
    }

    if (String(book.userId) === String(req.user._id)) {
      return res.status(400).json({
        success: false,
        message: "You can't request your own book.",
      });
    }

    if (book.status !== "Approved") {
      return res.status(400).json({
        success: false,
        message: "Book unavailable.",
      });
    }

    const exists = await deliveryCollection.findOne({
      bookId: new ObjectId(bookId),
      userId: new ObjectId(req.user._id),
    });

    if (exists) {
      return res.status(400).json({
        success: false,
        message: "Already requested.",
      });
    }

    const delivery = {
      bookId: new ObjectId(bookId),
      userId: new ObjectId(req.user._id),
      librarianId: new ObjectId(book.userId),
      title: book.title,
      deliveryFee: book.deliveryFee || 0,
      status: "Pending",
      requestedAt: new Date(),
    };

    await deliveryCollection.insertOne(delivery);

    res.json({
      success: true,
      message: "Delivery requested successfully.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});



app.get("/api/librarian/deliveries", verifyToken, async (req, res) => {
  await dbConnect();

  try {
    const deliveries = await deliveryCollection
      .aggregate([
        {
          $match: {
            librarianId: new ObjectId(req.user._id),
          },
        },
        {
          $lookup: {
            from: "user",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        {
          $unwind: "$user",
        },
        {
          $sort: {
            requestedAt: -1,
          },
        },
      ])
      .toArray();

    res.json(deliveries);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Server Error",
    });
  }
});



app.patch("/api/librarian/deliveries/:id", verifyToken, async (req, res) => {
  await dbConnect();

  try {
    const { status } = req.body;

    await deliveryCollection.updateOne(
      {
        _id: new ObjectId(req.params.id),
      },
      {
        $set: {
          status,
        },
      }
    );

    res.json({
      success: true,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
    });
  }
});


app.patch("/api/librarian/books/unpublish/:id", verifyToken, async (req, res) => {
  await dbConnect();

  try {
    const { id } = req.params;

    const result = await booksCollection.updateOne(
      {
        _id: new ObjectId(id),
        userId: new ObjectId(req.user._id),
        status: "Approved",
      },
      {
        $set: {
          status: "UnApproved",
        },
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Book not found or already unpublished",
      });
    }

    res.json({
      success: true,
      message: "Book unpublished successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});


app.post("/api/reviews", verifyToken, async (req, res) => {
  await dbConnect();

  try {
    const { bookId, rating, comment } = req.body;

    //  Validate input
    if (!bookId || !rating || !comment) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    //  1. CHECK DELIVERY STATUS (MAIN REQUIREMENT)
    const delivery = await deliveryCollection.findOne({
      userId: new ObjectId(req.user._id),
      bookId: new ObjectId(bookId),
      status: "Delivered",
    });

    

    if (!delivery) {
      return res.status(403).json({
        success: false,
        message: "You can only review delivered books",
      });
    }
 
    const review = {
      bookId: new ObjectId(bookId),
      userId: new ObjectId(req.user._id),
      userName: req.user.name || "Anonymous",
      rating: Number(rating),
      comment,
      createdAt: new Date(),
    };

    await reviewCollection.insertOne(review);

    res.status(201).json({
      success: true,
      message: "Review added successfully",
    });
  } catch (err) {
    console.error("Review Error:", err);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});

app.get("/api/reviews/:bookId", async (req, res) => {
  await dbConnect();

  try {
    const reviews = await reviewCollection
      .find({
        bookId: new ObjectId(req.params.bookId),
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(reviews);
  } catch (err) {
    console.error("Fetch Review Error:", err);

    res.status(500).json({
      error: "Server Error",
    });
  }
});


app.get("/api/user/borrowed-books", verifyToken, async (req, res) => {
  await dbConnect();
  

  try {
    const userId = new ObjectId(req.user._id);

    const books = await booksCollection
      .find({ borrowerId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(books);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.post("/api/books/borrow/:bookId", verifyToken, async (req, res) => {
  await dbConnect();

  try {
    const { bookId } = req.params;

    const result = await booksCollection.updateOne(
      { _id: new ObjectId(bookId) },
      {
        $set: {
          borrowerId: new ObjectId(req.user._id),
          status: "Borrowed"
        }
      }
    );

    res.json({
      success: true,
      message: "Book borrowed successfully"
    });
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});


app.get("/api/admin/overview", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  try {
    const totalUsers = await userCollection.countDocuments();
    const totalBooks = await booksCollection.countDocuments();
    const pendingBooks = await booksCollection.countDocuments({ status: "Pending" });

    const revenueAgg = await paymentCollection.aggregate([
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]).toArray();

    res.json({
      totalUsers,
      totalBooks,
      pendingBooks,
      totalRevenue: revenueAgg[0]?.total || 0
    });

  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/admin/users", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  const users = await userCollection.find().toArray();
  res.json(users);
});

app.patch("/api/admin/users/:id", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  const { role } = req.body;

  const result = await userCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { role } }
  );

  res.json(result);
});

app.delete("/api/admin/users/:id", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  await userCollection.deleteOne({
    _id: new ObjectId(req.params.id),
  });

  res.json({ success: true });
});

app.get("/api/admin/books", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  try {
    const books = await booksCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    console.log("BOOKS COUNT:", books.length); // 🔥 debug

  res.json(books);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.patch("/api/admin/books/approve/:id", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  await booksCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status: "Approved" } }
  );

  res.json({ success: true });
});

app.patch("/api/admin/books/reject/:id", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  await booksCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status: "Rejected" } }
  );

  res.json({ success: true });
});


app.delete("/api/admin/books/:id", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  await booksCollection.deleteOne({
    _id: new ObjectId(req.params.id),
  });

  res.json({ success: true });
});

app.get("/api/admin/transactions", verifyToken, isAdmin, async (req, res) => {
  await dbConnect();

  const transactions = await paymentCollection
    .find()
    .sort({ createdAt: -1 })
    .toArray();

  res.json(transactions);
});



app.get("/api/librarian/overview", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    // ১. আইডিটিকে নিশ্চিতভাবে ObjectId তে রূপান্তর করা
    const librarianId = new ObjectId(req.user.id);
    
    // ২. ফিল্টার কনসোল লগ করে দেখুন ফিল্টারটি কেমন দেখাচ্ছে
    const query = { userId: librarianId };
    console.log("DEBUG: Final Query Filter:", query);

    // ৩. ডাটাবেস কুয়েরি
    const myBooks = await booksCollection.countDocuments(query);
    const approvedBooks = await booksCollection.countDocuments({ ...query, status: "Approved" });
    const pendingBooks = await booksCollection.countDocuments({ ...query, status: "Pending" });
    const totalRequests = await deliveryCollection.countDocuments({ librarianId: librarianId });

    console.log("DEBUG: Found myBooks:", myBooks);

    res.json({
      myBooks,
      publishedBooks: approvedBooks,
      pendingBooks,
      totalRequests
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/librarian/transactions", verifyToken, async (req, res) => {
  await dbConnect();

  try {
    const librarianId = req.user.id; // এটি স্ট্রিং '6a3d127c37aae54a90864702' দিবে

    const transactions = await deliveryCollection
      .find({
        librarianId,
        status: "Delivered",
      })
      .sort({
        requestedAt: -1,
      })
      .toArray();

    res.json(transactions);
  } catch (err) {
    res.status(500).json({
      error: "Server Error",
    });
  }
});


app.get("/api/librarian/chart", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const librarianId = new ObjectId(req.user.id);
    const pending = await booksCollection.countDocuments({ userId: librarianId, status: "Pending" });
    const approved = await booksCollection.countDocuments({ userId: librarianId, status: "Approved" });
    const unApproved = await booksCollection.countDocuments({ userId: librarianId, status: "UnApproved" });

    res.json([
      { name: "Pending", value: pending },
      { name: "Published", value: approved },
      { name: "Unpublished", value: unApproved },
    ]);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

// Export for Vercel
module.exports = app;

// Local Development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port: ${PORT}`));
}