import express from "express";
import jwt from "jsonwebtoken";
import MD5 from 'crypto-js/md5'

export default async function LoginBackend(client) {

	const router = express.Router();
	const SECRET_KEY = "focusHavenletsGrowTogether";

	const db = client.db("username-pass");
	const userCollection = db.collection("usernamePasswords");

	function isNumeric(str) {
		return !isNaN(str) && !isNaN(parseFloat(str));
	  }
	  

	// ✅ Login Route - Generates JWT & Stores in HTTP-Only Cookie
	router.post("/", async (req, res) => {
		const {username, password} = req.body;
		let user = null;
		if(isNumeric(username)){
			user = await userCollection.findOne({FHiD: parseInt(username)})
		}else if (!isNumeric(username)){
			user = await userCollection.findOne({username: username})
		}

		if (!user) {
			return res.status(401).json({
			  success: false,
			  message: "User Not Found"
			});
		  }
		  
		  const validPassword = MD5(user.password).toString() === password;
		  
		  if (!validPassword) {
			return res.status(401).json({
			  success: false,
			  error: "Invalid credentials"
			});
		  }
		  
		  if (!isNumeric(username)) {
			if (user.username !== username) {
			  return res.status(401).json({
				success: false,
				error: "Invalid credentials"
			  });
			}
		  } else {
			if (user.FHiD !== parseInt(username)) {
			  return res.status(401).json({
				success: false,
				error: "Invalid credentials"
			  });
			}
		  }
		  
		  // ✅ If we've reached here, login is successful
		  const token = jwt.sign({ username }, SECRET_KEY);
		  
		  res.cookie("authToken", token, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "Lax"
		  });
		  
		  return res.json({
			success: true,
			message: "Login successful"
		  });

	});

	// ✅ Protected Route - Verifies Authentication
	router.get("/protected", (req, res) => {
		const token = req.cookies.authToken; // Extract token from cookie

		if (!token) {
			return res.status(401).json({
				success: false,
				message: "Unauthorized"
			});
		}

		try {
			const decoded = jwt.verify(token, SECRET_KEY);
			return res.json({
				success: true,
				user: decoded
			});
		} catch (error) {
			return res.status(403).json({
				success: false,
				message: "Invalid token"
			});
		}
	});

	// ✅ Logout Route - Clears the Authentication Cookie
	router.post("/logout", (req, res) => {
		res.clearCookie("authToken", {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "Lax"
		});
		return res.json({
			success: true,
			message: "Logged out successfully"
		});
	});

	return router;

	  
}