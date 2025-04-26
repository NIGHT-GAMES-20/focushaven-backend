import express from "express";

const router = express.Router();

router.post("/", (req, res) => {
  const { username, password } = req.body; // Correctly extracting values

  res.json({ 
    success: "Test For Sign In Successful", 
    username: username, 
    password: password  
  });
});

export default router;