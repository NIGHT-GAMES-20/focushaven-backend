import app from "./server.js";
import mongodb from "mongodb";
import dotenv from "dotenv";

dotenv.config();
const MongoClient = mongodb.MongoClient;

const MONGODB_USER = process.env['MONGODB_USER'];
const MONGODB_PASSWORD = process.env['MONGODB_PASSWORD'];

const uri = `mongodb+srv://${MONGODB_USER}:${MONGODB_PASSWORD}@cluster0.c0bhowt.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const PORT = 8000;

(async () => {
  try {
    const client = await MongoClient.connect(uri, {
      maxPoolSize: 50,
      wtimeoutMS: 2500,
    });

    const server = await app(client);
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (e) {
    console.error("Connection error:", e);
  }
})();
