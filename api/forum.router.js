import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import uuidpkg from 'uuid';
const { v4: uuidv4 } = uuidpkg;
import jwt from 'jsonwebtoken';
import { analyzeContent } from '../scripts/TextFilter.js';

dotenv.config();

export default async function questions(AstraDB) {
  const router = express.Router();
  const questionsCollection = AstraDB.collection("questions");
  const questionsHeldCollection = AstraDB.collection("questions_held_for_review");

  const pageSize  = 10; // Number of items per page

  router.post("/auth/token", async (req, res) => {
    try {
      const origin = req.get('Origin') || '';

      const allowedOrigin = process.env['FRONTEND_URL'];
      if (!allowedOrigin) {
          return res.status(500).json({ message: "Server misconfigured: FRONTEND_URL not set" });
      }

      if (!origin.includes(allowedOrigin)) {
          return res.status(403).json({ message: 'Unauthorized origin' });
      }

      const secret = process.env['SECRET_KEY'];
      if (!secret) {
          return res.status(500).json({ message: "Server misconfigured: SECRET_KEY not set" });
      }

      const payload = { sessionId: uuidv4() };
      const token = jwt.sign(payload, secret, { expiresIn: '5m' });

      res.json({ success: true, token });
    } catch (err) {
      res.status(500).json({ message: 'Token generation failed', error: err.message });
    }
  });

router.post('/ask', async (req, res) => { 
  const authToken = req.cookies.authToken;
  if (!authToken) {
    return res.status(401).json({
      success: false,
      message: "Authentication Failed"
    });
  }
  const { title, body, tags } = req.body;
  const user = jwt.verify(authToken, process.env['SECRET_KEY']).username;
  if (!title || !body) {
    return res.status(400).json({ success: false, message: "Title and body are required" });
  }
  const filterResult = await analyzeContent([title, body, tags]);
  if (!filterResult.success){
    return res.status(500).json({ success: false, message: filterResult.message, error: filterResult.error });
  }

  const question = {
    title,
    body,
    tags: tags,
    user,
    CreatedAt: new Date(),
    Likes: 0
  }
  
  try{
    if(filterResult.harmScore < 1.0 && filterResult.flaggedAttributes.length === 0) {
      question.status = 'published';
      await questionsCollection.insertOne(question);
      return res.status(200).json({ success: true, message: "Question submitted successfully" });

    }else if(filterResult.harmScore >= 1.0 && filterResult.flaggedAttributes.length >= 1 && filterResult.harmScore < 6.0){
      question.status = 'held_for_review';
      question.flaggedAttributes = filterResult.flaggedAttributes;
      question.harmScore = filterResult.harmScore;
      await questionsHeldCollection.insertOne(question);
      return res.status(200).json({ success: true, message: "Question held for review due to harmful content" });

    }else if (filterResult.harmScore >= 6.0 && filterResult.flaggedAttributes.length >= 1){

      return res.status(400).json({
        success: false,
        message: "Question contains harmful content and has been rejected",
        flaggedAttributes: filterResult.flaggedAttributes,
        harmScore: filterResult.harmScore
      });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to insert question", error: error.message });
  }
});

  router.get("/questions", authMiddleware, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const sortByLikes = req.query.sortByLikes === 'true';
    const sortOption = sortByLikes ? { Likes: -1 } : { CreatedAt: -1 };
    const skip = (page - 1) * pageSize;

    try {
        const questions = await questionsCollection.find({}).sort(sortOption).skip(skip).limit(pageSize).toArray();
        res.json({ success: true, questions: questions});
    } catch (err) {
        res.status(500).json({ message: 'Internal server error' , error: err.message });
    }
  });

  router.get("/questions/pages", authMiddleware, async (req, res) => {
    try {
      const count = await questionsCollection.countDocuments({},Number.MAX_SAFE_INTEGER);
      const pageCount = Math.ceil(count / pageSize); // Assuming 10 items per page
      res.json({ success: true, pages: pageCount });
    } catch (err) {
      res.status(500).json({ message: 'Internal server error' , error: err.message });
    }
  });

  router.get("/search/questions", authMiddleware, async (req, res) => {
    const searchText = req.query.search;
    if (!searchText) {
      return res.status(400).json({ message: 'Search text is required' });
    }

    const searchVector = await inferenceAPI(searchText);
    if( Object.keys(searchVector).length !== 1024) {
      return res.status(searchVector.status || 500).json({ message: searchVector.error || 'Error processing search vector' });
    }
    try {
      const results = await questionsCollection.find({},{ projection: { text: 1}, sort: { $vector: searchVector }}).limit(pageSize).toArray();
      res.json({ success: true, results: results });
    } catch (err) {
      res.status(500).json({ message: 'Internal server error', error: err.message });
    }
  });

  router.post("/questions/held", async (req, res) => {
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    const user = jwt.verify(authToken, process.env['SECRET_KEY']).username;
    if (!user) {
      return res.status(403).json({ success: false, message: "User not Found" });
    }
    if (user.admin === false) {
      return res.status(403).json({ success: false, message: "Admin Auth Failed" });
    }
    try{
      const heldQuestions = await questionsHeldCollection.find({}).toArray();
      if (heldQuestions.length === 0) {
        return res.status(200).json({ success: true, message: "No held questions found" });
      }else {
        return res.status(200).json({ success: true, heldQuestions: heldQuestions });
      }
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  })

    
  return router;
}

async function inferenceAPI(input) {
    const API_URL = "https://router.huggingface.co/hf-inference/models/intfloat/multilingual-e5-large/pipeline/feature-extraction";
    const HEADERS = {
        "Authorization": `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
        "Content-Type": "application/json"
    };

    const body = JSON.stringify({ inputs: input });

    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: HEADERS,
            body
        });

        if (!res.ok) {
            return {error: `API Error: ${res.statusText}`, status: res.status};;
        }

        const text = await res.text();
        const json = JSON.parse(text);
        return json;
    } catch (err) {
        return {error: err};
    }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ message: "Invalid Authentication" });
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  try {
    const decoded = jwt.verify(token, process.env['SECRET_KEY']);
    req.uuid = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Invalid or expired token' , error: err.message });
  }
}
