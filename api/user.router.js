import express from "express";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();

export default async  function userRoute(client){
  const userCollection = client.collection("username_passwords");

  router.get("/getUserInfo", (req, res) => {
    const token = req.cookies.authToken;
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const decoded = jwt.verify(token, process.env.SECRET_KEY);
    if (!decoded) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    userCollection.findOne({ username: decoded.username }, { projection: { password: 0 } })
      .then(user => {
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        res.status(200).json({success: true, user });
      })
      .catch(err => {
        console.error("Error fetching user info:", err);
        res.status(500).json({ error: "Internal server error" });
      });    
  });
  router.get("/allUserList", async (req, res) => {
    const token = req.cookies.authToken;
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const decoded = jwt.verify(token, process.env.SECRET_KEY);
    const admnUser = await userCollection.findOne({ username: decoded.username });
    
    if (!admnUser.admin) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const users  = await userCollection.find({}, { projection: { password: 0 } }).toArray();
    res.json({success: true, users});
  
  });
  return router
}