const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json()); 

const { MongoClient, ServerApiVersion } = require('mongodb');
const uri = process.env.MONGODB_URI

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,  
    strict: true,
    deprecationErrors: true,
  }  
});  
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)  
    await client.connect();
    const db = client.db("biblio")


    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error  
    // await client.close();
  }  
}  
run().catch(console.dir);



// Root Route
app.get('/', (req, res) => {
    res.send('Server is running smoothly!');
});

// Sample API Route
app.get('/api/data', (req, res) => {
    res.json({ message: "Hello from the separate backend server!" });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port: ${PORT}`);
});