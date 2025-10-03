import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import uuidpkg from 'uuid';
const { v4: uuidv4 } = uuidpkg;
import jwt from 'jsonwebtoken';
import { analyzeContent } from '../scripts/TextFilter.js';
import crypto from "crypto";
import rateLimit, {ipKeyGenerator} from 'express-rate-limit';

dotenv.config();

export default async function questions(AstraDB) {
  const router = express.Router();
  const questionsCollection = AstraDB.collection("questions");
  const questionsHeldCollection = AstraDB.collection("questions_held_for_review");
  const authRequests = AstraDB.collection("forum_auth_requests");

  const pageSize  = 10; // Number of items per page

  // Configure rate limiter for proxy environments
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 16, // limit each IP to 16 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts' },
    // Add proxy configuration to handle X-Forwarded-For header properly
    trustProxy: true, // Enable if behind a proxy like Render, Heroku, etc.
    keyGenerator: ipKeyGenerator
  });
  router.use('/auth', authLimiter);

  // 1️⃣ Request auth_code
  router.post("/auth/request", async (req, res) => {
    const { code_challenge } = req.body;
    if (!code_challenge) return res.status(400).json({ error: "Missing code_challenge" });

    const auth_code = crypto.randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 45 * 1000; // 45 Seconds validity

    await authRequests.insertOne({
      _id: auth_code,
      code_challenge,
      expiresAt
    });

    res.json({ auth_code });
  });

  // 2️⃣ Redeem auth_code with verifier → issue JWT
  router.post("/auth/token", async (req, res) => {
    const { auth_code, code_verifier } = req.body;
    const record = await authRequests.findOne({ _id: auth_code });

    if (!record) return res.status(400).json({ error: "Invalid auth_code" });
    if (Date.now() > record.expiresAt) {
      await authRequests.deleteOne({ _id: auth_code });
      return res.status(400).json({ error: "auth_code expired" });
    }

    // Validate verifier
    const challengeCheck = crypto
      .createHash("sha256")
      .update(code_verifier)
      .digest("base64url");

    if (challengeCheck !== record.code_challenge) {
      return res.status(400).json({ error: "code_verifier mismatch" });
    }

    // Cleanup
    await authRequests.deleteOne({ _id: auth_code });

    // ✅ Issue JWT
    const token = jwt.sign(
      { sub: uuidv4(), issued: Date.now() },
      process.env['SECRET_KEY'],
      { expiresIn: "10m" }
    );

    res.json({ success: true, token });
  });


  //Ask Question
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
    if (!user) {
      return res.status(403).json({ success: false, message: "malformed " });
    }
    const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user });
    if (!DBUser) {
      return res.status(403).json({ success: false, message: "User not Found" });
    }

    if (!title || !body) {
      return res.status(400).json({ success: false, message: "Title and body are required" });
    }
    const filterResult = await analyzeContent([title, body, tags]);
    if (!filterResult.success){
      return res.status(500).json({ success: false, message: filterResult.message, error: filterResult.error });
    }

    const textInput = `${title}\n${body}\n${tags.join(', ')}`;
    const embedding = await inferenceAPI(textInput);

    const userQuestionRateLimiter = DBUser.RateLimiter?.questions || {};
    if (userQuestionRateLimiter){
      const windowTime = 10 * 60 * 1000; // 5 minutes
      if (userQuestionRateLimiter?.timeStamp && Date.now() - userQuestionRateLimiter.timeStamp < windowTime ){
        return res.status(429).json({
          success: false,
          message: "Rate limit exceeded. Please wait before posting another question.",
          retryAfter: Math.ceil((windowTime - (Date.now() - userQuestionRateLimiter.timeStamp)) / 1000), // in seconds
          conflicted:{
            lastQuestion: userQuestionRateLimiter.question,
            lastQuestionId: userQuestionRateLimiter.questionId,
            lastQuestionTime: new Date(userQuestionRateLimiter.timeStamp).toISOString(),
          }
        });
      }
    }
    // Timestamp and Question ID
    const  questionId = generateTimeBasedId();
    const currentTime = Date.now();

    const question = {
      _id: questionId,
      title,
      body,
      tags: tags,
      user,
      $vector: embedding,
      CreatedAt: currentTime,
      Likes: 0,
      Likers: []
    }

    // Update User's Rate Limiter Info
    /*
    const newQuestionRateLimiter = {
      question: title,
      questionId: questionId,
      timeStamp: currentTime
    }
    */
    //await AstraDB.collection("username_passwords").updateOne({ username: user }, { $set: { "RateLimiter.questions": newQuestionRateLimiter } });
    
    try{
      if(filterResult.harmScore < 1.0 && filterResult.flaggedAttributes.length === 0) {
        question.status = 'published';
        await questionsCollection.insertOne(question);
        console.log('Inserted Question:', question);     
        console.log('Filter Result:', filterResult);
        return res.status(200).json({ success: true, message: "Question submitted successfully", filterResult });

      }else if(filterResult.harmScore >= 1.0 && filterResult.flaggedAttributes.length >= 1 && filterResult.harmScore < 6.0){
        question.status = 'held_for_review';
        question.flaggedAttributes = filterResult.flaggedAttributes;
        question.harmScore = filterResult.harmScore;
        await questionsHeldCollection.insertOne(question);
        console.log('Inserted Question:', question);     
        console.log('Filter Result:', filterResult);
        return res.status(200).json({ success: true, message: "Question held for review due to harmful content", filterResult });

      }else if (filterResult.harmScore >= 6.0 && filterResult.flaggedAttributes.length >= 1){

        console.log('Inserted Question:', question);     
        console.log('Filter Result:', filterResult);
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

  //Get Questions with Pagination and Sorting
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

  //Get Total Pages
  router.get("/questions/pages", authMiddleware, async (req, res) => {
    try {
      const count = await questionsCollection.countDocuments({},Number.MAX_SAFE_INTEGER);
      const pageCount = Math.ceil(count / pageSize); // Assuming 10 items per page
      res.json({ success: true, pages: pageCount });
    } catch (err) {
      res.status(500).json({ message: 'Internal server error' , error: err.message });
    }
  });

  //Search Questions
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
      const results = await questionsCollection.find({},{sort: { $vector: searchVector }}).limit(pageSize).toArray();
      res.json({ success: true, results: results });
    } catch (err) {
      res.status(500).json({ message: 'Internal server error', error: err.message });
    }
  });

  //Admin: Get Held Questions for Review
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
    const userDB = await AstraDB.collection("username_passwords").findOne({ username: user });
    if (!userDB || !userDB.admin) {
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

  //Admin: Approve or Reject Held Questions
  router.post("/questions/approve", async (req, res) => {
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
    const userDB = await AstraDB.collection("username_passwords").findOne({ username: user });
    if (!userDB || !userDB.admin) {
      return res.status(403).json({ success: false, message: "Admin Auth Failed" });
    }

    const { questionId, isApproved } = req.body;

    if (!questionId || typeof isApproved !== 'boolean') {
      return res.status(400).json({ success: false, message: "Invalid request data" });
    }

    try {
      const question = await questionsHeldCollection.findOne({ _id: questionId });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }

      if (isApproved) {
        question.status = 'published';
        await questionsCollection.insertOne(question);
      } else {
        question.status = 'rejected';
      }

      await questionsHeldCollection.deleteOne({ _id: questionId });

      return res.status(200).json({ success: true, message: isApproved ? "Question approved and published" : "Question rejected" });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }

  });

  //Get Question Data
  router.get("/question/data/:questionID", authMiddleware, async (req, res) => {
    const questionID = req.params.questionID;
    if (!questionID) {
      return res.status(400).json({ success: false, message: "Question ID is required" });
    }

    try {
      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      return res.status(200).json({ success: true, question: question });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  })

  //Like Question
  router.post("/question/like", authMiddleware, async (req, res) => {
    const { questionID } = req.body;
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }

    if (!questionID) {
      return res.status(400).json({ 
        success: false, 
        message: "Question ID is required" 
      });
    }
    
    const user = jwt.verify(authToken, process.env['SECRET_KEY']).username;
    if (!user) {
      return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
    }

    try {

      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user });
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }

      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      
      if (question.Likers && question.Likers.includes(DBUser.FHiD)) {
        const updatedLikes = question.Likes > 0 ? question.Likes - 1 : 0;
        const filteredLikers = (question.Likers || []).filter(id => id !== DBUser.FHiD);
        await questionsCollection.updateOne({ _id: questionID }, { $set: { Likes: updatedLikes, Likers: filteredLikers } });
        const updatedQuestion = await questionsCollection.findOne({ _id: questionID });
        return res.status(200).json({ success: true, message: "Question unliked", Likes: updatedQuestion.Likes, Likers: updatedQuestion.Likers });
      }

      const updatedLikes = (question.Likes || 0) + 1;

      await questionsCollection.updateOne({ _id: questionID }, { $set: { Likes: updatedLikes }, $addToSet: { Likers: DBUser.FHiD } });
      const updatedQuestion = await questionsCollection.findOne({ _id: questionID });

      return res.status(200).json({ success: true, message: "Question liked", Likes: updatedQuestion.Likes, Likers: updatedQuestion.Likers });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  })

  //Delete Question
  router.post("/question/delete/:questionID", authMiddleware, async (req, res) => {
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    const user = jwt.verify(authToken, process.env['SECRET_KEY']);
    if (!user) {
      return res.status(403).json({ success: false, message: "User not Found" });
    }

    const questionID = req.params.questionID;
    if (!questionID) {
      return res.status(400).json({ success: false, message: "Question ID is required" });
    }
    try {
      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user.username } ,{projection: { admin: 1 }});
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }

    if (question.user !== user.username && DBUser.admin !== true) {
      return res.status(403).json({ success: false, message: "You can only delete your own questions" });
    }

      await questionsCollection.deleteOne({ _id: questionID });
      return res.status(200).json({ success: true, message: "Question deleted successfully" });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  })

  //Edit Question
  router.post("/question/edit/:questionID", authMiddleware, async (req, res) => {
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    const user = jwt.verify(authToken, process.env['SECRET_KEY']);
    if (!user) {
      return res.status(403).json({ success: false, message: "User not Found" });
    }
    const questionID = req.params.questionID;
    const { title, body, tags } = req.body;
    if (!questionID || !title || !body) {
      return res.status(400).json({ success: false, message: "Question ID, title and body are required" });
    }
    try {
      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      if (question.user !== user.username) {
        return res.status(403).json({ success: false, message: "You can only edit your own questions" });
      }
      const filterResult = await analyzeContent([title, body, tags]);
      if (!filterResult.success){
        return res.status(500).json({ success: false, message: filterResult.message, error: filterResult.error });
      }
      if(filterResult.harmScore < 1.0 && filterResult.flaggedAttributes.length === 0) {
        const textInput = `${title}\n${body}\n${tags.join(', ')}`;
        const embedding = await inferenceAPI(textInput);
        await questionsCollection.updateOne({ _id: questionID }, { $set: { title, body, tags, $vector: embedding,EdittedAt: new Date() }});
        return res.status(200).json({ success: true, message: "Question updated successfully" });
      }else if (filterResult.harmScore >= 1.0 && filterResult.flaggedAttributes.length >= 1){
        return res.status(400).json({
          success: false,
          message: "Question contains harmful content and has been rejected",
          flaggedAttributes: filterResult.flaggedAttributes,
          harmScore: filterResult.harmScore
        });
      }
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });

  //Post Comment on Question
  router.post("/question/comment/post", authMiddleware, async (req, res) => {
    const { questionID, comment } = req.body;
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    if (!questionID || !comment) {
      return res.status(400).json({ success: false, message: "Question ID and comment are required" });
    }

    const filterResult = await analyzeContent([comment]);
    if (!filterResult.success){
      return res.status(500).json({ success: false, message: filterResult.message, error: filterResult.error });
    }
    try {
      const user = jwt.verify(authToken, process.env['SECRET_KEY']).username;
      if (!user) {
        return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
      }
      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user });
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }

      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }

      const userCommentRateLimiter = DBUser.RateLimiter?.comments || {};
      if (userCommentRateLimiter){
        const windowTime = 1 * 60 * 1000; // 1 minute
        if (userCommentRateLimiter?.timeStamp && Date.now() - userCommentRateLimiter.timeStamp < windowTime ){
          return res.status(429).json({ 
            success: false,
            message: "Rate limit exceeded. Please wait before posting another comment.",
            retryAfter: Math.ceil((windowTime - (Date.now() - userCommentRateLimiter.timeStamp)) / 1000), // in seconds
            conflicted:{
              lastComment: userCommentRateLimiter.comment,
              lastCommentId: userCommentRateLimiter.commentId,
              lastCommentTime: new Date(userCommentRateLimiter.timeStamp).toISOString(),
            }
          });
        }
      }
      //Comment ID and Timestamp
      const commentId = generateTimeBasedId();
      const currentTime = Date.now();

      //New Comment Object
      const newComment = {
        _id: commentId,
        user: user,
        comment: comment,
        Likes: 0,
        Likers: [],
        CreatedAt: currentTime,
        DeleteAt: (new Date(currentTime)).setMonth((new Date(currentTime)).getMonth() + 2) // Auto-delete after 2 months using Cron job
      };

      // Update User's Rate Limiter Info
      const newCommentRateLimiter = {
        comment: comment,
        commentId: commentId,
        timeStamp: currentTime
      }

      await AstraDB.collection("username_passwords").updateOne({ username: user }, { $set: { "RateLimiter.comments": newCommentRateLimiter } });

      if(filterResult.harmScore < 2.0 && filterResult.flaggedAttributes.length <= 2) {
        const updatedComments = question.comments ? [...question.comments, newComment] : [newComment];
        await questionsCollection.updateOne({ _id: questionID }, { $set: { comments: updatedComments } });
        return res.status(200).json({ success: true, message: "Comment added successfully", comment: newComment });
      }else if (filterResult.harmScore >= 2.0 && filterResult.flaggedAttributes.length > 2){
        return res.status(400).json({
          success: false,
          message: "Comment contains harmful content and has been rejected",
          flaggedAttributes: filterResult.flaggedAttributes,
          harmScore: filterResult.harmScore
        });
      }

    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });

  //Post Answer on Question
  router.post("/question/answer/post", authMiddleware, async (req, res) => {
    const { questionID, answer } = req.body;
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    if (!questionID || !answer) {
      return res.status(400).json({ success: false, message: "Question ID and answer are required" });
    }

    // FIXED: Changed 'comment' to 'answer' in the analyzeContent call
    const filterResult = await analyzeContent([answer]);
    if (!filterResult.success){
      return res.status(500).json({ success: false, message: filterResult.message, error: filterResult.error });
    }
    
    try {
      const user = jwt.verify(authToken, process.env['SECRET_KEY']).username;
      if (!user) {
        return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
      }
      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user });
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }

      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }


      const userAnswerRateLimiter = DBUser.RateLimiter?.answers || {};
      if (userAnswerRateLimiter){
        const windowTime = 2 * 60 * 1000; // 2 minutes
        if (userAnswerRateLimiter?.timeStamp && Date.now() - userAnswerRateLimiter.timeStamp < windowTime ){
          return res.status(429).json({
            success: false,
            message: "Rate limit exceeded. Please wait before posting another answer.",
            retryAfter: Math.ceil((windowTime - (Date.now() - userAnswerRateLimiter.timeStamp)) / 1000), // in seconds
            conflicted:{
              lastAnswer: userAnswerRateLimiter.answer,
              lastAnswerId: userAnswerRateLimiter.answerId,
              lastAnswerTime: new Date(userAnswerRateLimiter.timeStamp).toISOString(),
            }
          });
        }
      }
      //Answer ID and Timestamp
      const answerId = generateTimeBasedId();
      const currentTime = Date.now();

      //New Answer Object
      const newAnswer = {
        _id: answerId,
        user: user,
        answer: answer,
        status: 'unverified', // FIXED: Changed 'staus' to 'status'
        Likes: 0,
        Likers: [],
        CreatedAt: currentTime,
      };

      // Update User's Rate Limiter Info
      const newAnswerRateLimiter = {
        answer: answer,
        answerId: answerId,
        timeStamp: currentTime
      }
      await AstraDB.collection("username_passwords").updateOne({ username: user }, { $set: { "RateLimiter.answers": newAnswerRateLimiter } });

      if(filterResult.harmScore < 2.0 && filterResult.flaggedAttributes.length <= 2) {
        const updatedAnswers = question.answers ? [...question.answers, newAnswer] : [newAnswer];
        await questionsCollection.updateOne({ _id: questionID }, { $set: { answers: updatedAnswers } });
        return res.status(200).json({ success: true, message: "Answer added successfully", answer: newAnswer });
      }else if (filterResult.harmScore >= 2.0 && filterResult.flaggedAttributes.length > 2){
        return res.status(400).json({
          success: false,
          message: "Answer contains harmful content and has been rejected",
          flaggedAttributes: filterResult.flaggedAttributes,
          harmScore: filterResult.harmScore
        });
      }
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });

  //Like Comment
  router.post("/question/comment/like", authMiddleware, async (req, res) => {
    const { questionID, commentID } = req.body;
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    if (!questionID || !commentID) {
      return res.status(400).json({ 
        success: false, 
        message: "Question ID and Comment ID are required" 
      });
    }
    
    try {
      const user = jwt.verify(authToken, process.env['SECRET_KEY']).username;
      if (!user) {
        return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
      }
      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user });
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }
      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      const comment = question.comments ? question.comments.find(c => c._id === commentID) : null;
      if (!comment) {
        return res.status(404).json({ success: false, message: "Comment not found" });
      }


      if (comment.Likers && comment.Likers.includes(DBUser.FHiD)) {
        const updatedLikes = comment.Likes > 0 ? comment.Likes - 1 : 0;
        const filteredLikers = (comment.Likers || []).filter(id => id !== DBUser.FHiD);
        const updatedComments = question.comments.map(c => c._id === commentID ? { ...c, Likes: updatedLikes, Likers: filteredLikers } : c);
        await questionsCollection.updateOne({ _id: questionID }, { $set: { comments: updatedComments } });
        return res.status(200).json({ success: true, message: "Comment unliked", Likes: updatedLikes, Likers: filteredLikers });
      }
      const updatedLikes = (comment.Likes || 0) + 1;
      const updatedComments = question.comments.map(c => c._id === commentID ? { ...c, Likes: updatedLikes, Likers: [...(c.Likers || []), DBUser.FHiD] } : c);
      await questionsCollection.updateOne({ _id: questionID }, { $set: { comments: updatedComments } });
      return res.status(200).json({ success: true, message: "Comment liked", Likes: updatedLikes, Likers: [...(comment.Likers || []), DBUser.FHiD] });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });

  //Like Answer
  router.post("/question/answer/like", authMiddleware, async (req, res) => {
    const { questionID, answerID } = req.body;
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    if (!questionID || !answerID) {
      return res.status(400).json({ 
        success: false, 
        message: "Question ID and Answer ID are required" 
      });
    }
    try {
      const user = jwt.verify(authToken, process.env['SECRET_KEY']).username;
      if (!user) {
        return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
      }
      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user });
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }
      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      const answer = question.answers ? question.answers.find(a => a._id === answerID) : null;
      if (!answer) {
        return res.status(404).json({ success: false, message: "Answer not found" });
      }
      if (answer.Likers && answer.Likers.includes(DBUser.FHiD)) {
        const updatedLikes = answer.Likes > 0 ? answer.Likes - 1 : 0;
        const filteredLikers = (answer.Likers || []).filter(id => id !== DBUser.FHiD);
        const updatedAnswers = question.answers.map(a => a._id === answerID ? { ...a, Likes: updatedLikes, Likers: filteredLikers } : a);
        await questionsCollection.updateOne({ _id: questionID }, { $set: { answers: updatedAnswers } });
        return res.status(200).json({ success: true, message: "Answer unliked", Likes: updatedLikes, Likers: filteredLikers });
      }
      const updatedLikes = (answer.Likes || 0) + 1;
      const updatedAnswers = question.answers.map(a => a._id === answerID ? { ...a, Likes: updatedLikes, Likers: [...(a.Likers || []), DBUser.FHiD] } : a);
      await questionsCollection.updateOne({ _id: questionID }, { $set: { answers: updatedAnswers } });
      return res.status(200).json({ success: true, message: "Answer liked", Likes: updatedLikes, Likers: [...(answer.Likers || []), DBUser.FHiD] });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });

  //delete Comment - User can delete their own comment, Admin can delete any comment
  router.post("/question/comment/delete", authMiddleware, async (req, res) => {
    const { questionID, commentID } = req.body;
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    if (!questionID || !commentID) {
      return res.status(400).json({ 
        success: false, 
        message: "Question ID and Comment ID are required" 
      });
    }
    try {
      const user = jwt.verify(authToken, process.env['SECRET_KEY']);
      if (!user) {
        return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
      }
      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user.username } ,{projection: { admin: 1, FHiD: 1 }});
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }
      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      const comment = question.comments ? question.comments.find(c => c._id === commentID) : null;
      if (!comment) {
        return res.status(404).json({ success: false, message: "Comment not found" });
      }
      if (comment.user !== user.username && DBUser.admin !== true) {
        return res.status(403).json({ success: false, message: "You can only delete your own comments" });
      }
      const updatedComments = question.comments.filter(c => c._id !== commentID);
      await questionsCollection.updateOne({ _id: questionID }, { $set: { comments: updatedComments } });
      return res.status(200).json({ success: true, message: "Comment deleted successfully" });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });

  //delete Answer - User can delete their own answer, Admin can delete any answer
  router.post("/question/answer/delete", authMiddleware, async (req, res) => {
    const { questionID, answerID } = req.body;
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    if (!questionID || !answerID) {
      return res.status(400).json({ 
        success: false, 
        message: "Question ID and Answer ID are required" 
      });
    }
    try {
      const user = jwt.verify(authToken, process.env['SECRET_KEY']);
      if (!user) {
        return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
      }
      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user.username } ,{projection: { admin: 1, FHiD: 1 }});
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }
      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      const answer = question.answers ? question.answers.find(a => a._id === answerID) : null;
      if (!answer) {
        return res.status(404).json({ success: false, message: "Answer not found" });
      }
      if (answer.user !== user.username && DBUser.admin !== true) {
        return res.status(403).json({ success: false, message: "You can only delete your own answers" });
      }
      const updatedAnswers = question.answers.filter(a => a._id !== answerID);
      await questionsCollection.updateOne({ _id: questionID }, { $set: { answers: updatedAnswers } });
      return res.status(200).json({ success: true, message: "Answer deleted successfully" });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });

  //edit comment - User can edit their own comment
  router.post("/question/comment/edit", authMiddleware, async (req, res) => {
    const { questionID, commentID, newComment } = req.body;
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    if (!questionID || !commentID || !newComment) {
      return res.status(400).json({
        success: false,
        message: "Question ID, Comment ID and new comment are required"
      });
    }
    const filterResult = await analyzeContent([newComment]);
    if (!filterResult.success){
      return res.status(500).json({ success: false, message: filterResult.message, error: filterResult.error });
    }
    try {
      const user = jwt.verify(authToken, process.env['SECRET_KEY']);
      if (!user) {
        return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
      }
      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user.username });
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }
      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      const comment = question.comments ? question.comments.find(c => c._id === commentID) : null;
      if (!comment) {
        return res.status(404).json({ success: false, message: "Comment not found" });
      }
      if (comment.user !== user.username) {
        return res.status(403).json({ success: false, message: "You can only edit your own comments" });
      }
      if(filterResult.harmScore < 2.0 && filterResult.flaggedAttributes.length < 2) {
        const updatedComments = question.comments.map(c => c._id === commentID ? { ...c, comment: newComment, EdittedAt: new Date() } : c);
        await questionsCollection.updateOne({ _id: questionID }, { $set: { comments: updatedComments } });
        return res.status(200).json({ success: true, message: "Comment updated successfully" });
      }else if (filterResult.harmScore >= 2.0 && filterResult.flaggedAttributes.length >= 2){
        return res.status(400).json({
          success: false,
          message: "Comment contains harmful content and has been rejected",
          flaggedAttributes: filterResult.flaggedAttributes,
          harmScore: filterResult.harmScore
        });
      }
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });

  //edit answer - User can edit their own answer
  router.post("/question/answer/edit", authMiddleware, async (req, res) => {
    const { questionID, answerID, newAnswer } = req.body;
    const authToken = req.cookies.authToken;

    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    if (!questionID || !answerID || !newAnswer) {
      return res.status(400).json({
        success: false,
        message: "Question ID, Answer ID and new answer are required"
      });
    }
    const filterResult = await analyzeContent([newAnswer]);
    if (!filterResult.success){
      return res.status(500).json({ success: false, message: filterResult.message, error: filterResult.error });
    }
    try {
      const user = jwt.verify(authToken, process.env['SECRET_KEY']);
      if (!user) {
        return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
      }
      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user.username });
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }
      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }
      const answer = question.answers ? question.answers.find(a => a._id === answerID) : null;
      if (!answer) {
        return res.status(404).json({ success: false, message: "Answer not found" });
      }
      if (answer.user !== user.username) {
        return res.status(403).json({ success: false, message: "You can only edit your own answers" });
      }
      if(filterResult.harmScore < 2.0 && filterResult.flaggedAttributes.length < 2) {
        const updatedAnswers = question.answers.map(a => a._id === answerID ? { ...a, answer: newAnswer, EdittedAt: new Date(), status: 'unverified' } : a);
        await questionsCollection.updateOne({ _id: questionID }, { $set: { answers: updatedAnswers } });
        return res.status(200).json({ success: true, message: "Answer updated successfully" }); 
      }else if (filterResult.harmScore >= 2.0 && filterResult.flaggedAttributes.length >= 2){
        return res.status(400).json({
          success: false,
          message: "Answer contains harmful content and has been rejected",
          flaggedAttributes: filterResult.flaggedAttributes,
          harmScore: filterResult.harmScore
        });
      }
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });

  //verify Answer - Admin can verify an answer
  router.post("/question/answer/verify", authMiddleware, async (req, res) => {
    const { questionID, answerID } = req.body;
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    if (!questionID || !answerID) {
      return res.status(400).json({ 
        success: false, 
        message: "Question ID and Answer ID are required" 
      });
    }
    try {
      const user = jwt.verify(authToken, process.env['SECRET_KEY']);
      if (!user) {
        return res.status(403).json({ success: false, message: "Invalid JWT Auth Token" });
      }

      const DBUser = await AstraDB.collection("username_passwords").findOne({ username: user.username } ,{projection: { admin: 1 }});
      if (!DBUser) {
        return res.status(403).json({ success: false, message: "User not Found" });
      }

      if (DBUser.admin !== true) {
        return res.status(403).json({ success: false, message: "Only admins can verify answers" });
      }

      const question = await questionsCollection.findOne({ _id: questionID });
      if (!question) {
        return res.status(404).json({ success: false, message: "Question not found" });
      }

      const answer = question.answers ? question.answers.find(a => a._id === answerID) : null;
      if (!answer) {
        return res.status(404).json({ success: false, message: "Answer not found" });
      }
      
      if (answer.status === 'verified') {
        return res.status(400).json({ success: false, message: "Answer is already verified" });
      }

      const updatedAnswers = question.answers.map(a => a._id === answerID ? { ...a, status: 'verified' } : a);
      await questionsCollection.updateOne({ _id: questionID }, { $set: { answers: updatedAnswers } });
      const questionAfterUpdate = await questionsCollection.findOne({ _id: questionID });
      return res.status(200).json({ success: true, message: "Answer verified successfully", question: questionAfterUpdate });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
  });
    
  //export router
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

function generateTimeBasedId(date = new Date()) {
  const buffer = new Uint8Array(12);

  // --- 6 bytes: timestamp in ms (48 bits, big-endian) ---
  const ms = BigInt(date.getTime());
  for (let i = 5; i >= 0; i--) {
    buffer[i] = Number((ms >> BigInt(i * 8)) & 0xffn);
  }

  // --- 6 bytes: random entropy ---
  crypto.getRandomValues(buffer.subarray(6));

  // --- Base64 encode (URL-safe, no padding) ---
  let b64 = btoa(String.fromCharCode(...buffer));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

