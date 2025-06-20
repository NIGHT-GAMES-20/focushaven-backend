import express from "express";
import nodemailer from "nodemailer";

export default function SigninBackend(client){

  const router = express.Router();
  
  router.post("/", async (req, res) => {
    const { name,username,password,email } = req.body; // Correctly extracting values
    if (!name || !username || !password ) {
      return res.status(400).json({ 
        success: false, 
        message: "All fields are required." 
      });
    }

    const collection = await client.collection("username_passwords");
    const FHiD = await generateUniqueId(collection);

    try {
      await collection.insertOne({
        name: name,
        username: username,
        email: email,
        FHiD: FHiD,
        password: password,
        admin: false,
      });

    } catch (error) {
      return res.status(500).json({ 
        success: false, 
        message: `Failed to create user. Error: ${error.message}` 
      });
    }

    return res.status(200).json({ 
      success: true, 
      message: "User created successfully.", 
      FHiD: FHiD
    });


  });


  router.get("/usernameValidation", async (req, res) => {
    const { username } = req.query; // Correctly extracting the username from query parameters
  
    if(!username){
      return res.status(400).json({ 
        success: false, 
        message: "Username is required." 
      });
    }

    const collection= client.collection("username_passwords");
    const user = await collection.findOne({ username: username }, { projection: { username: 1, _id: 0 }});

    if (!user) {
      return res.status(200).json({ 
        success: true, 
        message: "Username is available." 
      });
    }else {
      return res.status(200).json({ 
        success: false, 
        message: "Username is already taken." 
      });
    }

  });

  router.get("/emailValidation", async (req, res) => {
    const { email } = req.query; // Correctly extracting the username from query parameters
  
    if(!email){
      return res.status(400).json({ 
        success: false, 
        message: "Email is required." 
      });
    }

    const collection= client.collection("username_passwords");
    const user = await collection.findOne({ email: email }, { projection: { username: 1, _id: 0 }});

    if (!user) {
      return res.status(200).json({ 
        success: true, 
        message: "" 
      });
    }else {
      return res.status(200).json({ 
        success: false, 
        message: "Email is already registered." 
      });
    }

  });

  router.post("/sendEmailOTP", async (req, res) => {
    const { email } = req.body; // Correctly extracting the email from request body

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: "Email is required." 
      });
    }

    const OTP = Math.floor(100000 + Math.random() * 900000);
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const DeleteAt = Date.now() + 20 * 60 * 1000; // Optional: Set a delete time for the OTP record

    const collection = client.collection("otps");
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GOOGLE_APP_USER,     // your email (e.g. myapp@gmail.com)
        pass: process.env.GOOGLE_APP_PASSWORD,     // app password (not your Gmail password!)
      },
    });

    const mailOptions = {
      from: '"FocusHaven Support" <noreply.focushaven@gmail.com>',
      to: email,
      subject: 'OTP for Sign In',
      text: `\n\n\nYour OTP is: ${OTP}`,
    };

    try{
      await collection.insertOne({
        email: email,
        otp: OTP,
        Action: "signin",
        expiresAt: expiresAt,
        DeleteAt : DeleteAt
      });
      await transporter.sendMail(mailOptions);
    } catch (error) {
      return res.status(500).json({ 
        success: false, 
        message: `Failed to send OTP. Error: ${error.message}` 
      });
    }
    
    return res.status(200).json({ 
      success: true, 
      message: "OTP sent successfully." 
    });

  });

  router.post("/verifyEmailOTP", async (req, res) => {
    const { email, otp } = req.body; // Correctly extracting the email and OTP
    if (!email || !otp) {
      return res.status(400).json({ 
        success: false, 
        message: "Email and OTP are required." 
      });
    }

    const collection = client.collection("otps");
    const otpRecord = await collection.findOne({ email: email}, { projection: { otp: 1, expiresAt: 1 }, sort: { expiresAt: -1 }});

    if (!otpRecord) {
      return res.status(404).json({ 
        success: false, 
        message: "OTP not found for this email." 
      });
    }
    if (parseInt(otpRecord.expiresAt) < parseInt(Date.now())) {
      await collection.deleteOne({ _id:otpRecord._id});
      return res.status(200).json({ 
        success: false, 
        message: "OTP has expired." 
      });
    }

    if (parseInt(otpRecord.otp) !== parseInt(otp)) {
      return res.status(200).json({ 
        success: false, 
        message: "Invalid OTP." 
      });
    }

    // OTP is valid, proceed with sign-in logic
    await collection.deleteOne({ _id:otpRecord._id});
    return res.status(200).json({ 
      success: true, 
      message: "OTP verified successfully." 
    });

  });

  return router;
}

async function generateUniqueId(collection) {
  let unique = false;
  let newId;

  while (!unique) {
    newId = Math.floor(1_000_000_000 + Math.random() * 9_000_000_000); // 10-digit ID

    const existing = await collection.findOne({ id: newId });
    if (!existing) {
      unique = true;
    }
  }

  return newId;
}
