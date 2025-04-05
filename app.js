const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const app = express();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');
const usermodel = require('./model/user');
const postmodel = require("./model/post")
const { Municipality, Police, Electricity, RTO } = require('./model/departments');
const { categorizeComplaint, getGovernmentSchemeInfo } = require('./utils/categorizer');
const cookieParser = require('cookie-parser');
const { verify } = require('crypto');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Validate environment variables
if (!process.env.GEMINI_API_KEY) {
  console.error('Error: GEMINI_API_KEY is not set in .env file');
  process.exit(1);
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Function to get response from Gemini
async function getGeminiResponse(prompt) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Error getting Gemini response:', error);
    return "I apologize, but I'm having trouble processing your request at the moment. Please try again later.";
  }
}

// Define Complaint model schema if it doesn't exist yet
const complaintSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true,
    enum: ['INFRASTRUCTURE', 'WATER_SUPPLY', 'ELECTRICITY', 'SANITATION', 'HEALTHCARE', 'EDUCATION', 'TRANSPORTATION', 'OTHER']
  },
  location: {
    type: String,
    required: true
  },
  trackingId: {
    type: String,
    required: true,
    unique: true
  },
  priority: {
    type: String,
    required: true,
    enum: ['low', 'medium', 'high'],
    default: 'low'
  },
  status: {
    type: String,
    default: 'PENDING',
    enum: ['PENDING', 'PROCESSING', 'RESOLVED', 'REJECTED']
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  attachments: [String],
  comments: [{
    text: String,
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    role: String,
    createdAt: {
      type: Date,
      default: Date.now
    }
  }]
});

// Create model if it doesn't exist yet
let Complaint;
try {
  Complaint = mongoose.model('Complaint');
} catch (error) {
  Complaint = mongoose.model('Complaint', complaintSchema);
}

// MongoDB Connection with enhanced error handling
console.log('Attempting to connect to MongoDB...');
mongoose.connect('mongodb://127.0.0.1:27017/Data-Association', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  retryWrites: true,
  retryReads: true,
  maxPoolSize: 10,
  minPoolSize: 5
})
  .then(() => {
    console.log('Connected to MongoDB successfully');

    // Create default admin account if it doesn't exist
    createDefaultAdmin();
  })
  .catch((err) => {
    console.error('MongoDB connection error details:', {
      name: err.name,
      message: err.message,
      code: err.code,
      codeName: err.codeName
    });
    // Don't exit immediately, try to reconnect
    console.log('Attempting to reconnect...');
    setTimeout(() => {
      mongoose.connect('mongodb://localhost:27017/Data-Association', {
        useNewUrlParser: true,
        useUnifiedTopology: true
      }).catch(console.error);
    }, 5000);
  });

// Function to create default admin account
async function createDefaultAdmin() {
  try {
    // Check if admin already exists
    const adminExists = await usermodel.findOne({ role: 'ADMIN' });

    if (!adminExists) {
      // Create default admin account
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('admin123', salt);

      await usermodel.create({
        username: 'admin',
        name: 'Administrator',
        age: 30,
        email: 'admin@example.com',
        password: hash,
        role: 'ADMIN'
      });

      console.log('Default admin account created successfully');
      console.log('Email: admin@example.com');
      console.log('Password: admin123');
    } else {
      console.log('Admin account already exists');
    }
  } catch (error) {
    console.error('Error creating default admin account:', error);
  }
}

// Add connection event listeners
mongoose.connection.on('connected', () => {
  console.log('Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('Mongoose disconnected from MongoDB');
});

app.set('view engine', 'ejs');
app.set('layout', 'layout');
app.use(expressLayouts);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser())
app.use(express.static(path.join(__dirname, "public")));

// Add middleware to make user authentication state available to all pages
app.use(async (req, res, next) => {
  res.locals.user = null;
  const token = req.cookies.Token;

  if (token) {
    try {
      const decoded = jwt.verify(token, "shhh");
      const user = await usermodel.findById(decoded.userId);
      if (user) {
        res.locals.user = user;
      }
    } catch (error) {
      console.error('Token verification error:', error);
      // Clear invalid token
      res.clearCookie('Token');
    }
  }
  next();
});

app.get('/', (req, res) => {
  res.render('home', { title: 'Home' });
}
)
app.get('/create', (req, res) => {
  res.render('create', { title: 'Register' });
}
)

app.get("/profile", isLoggedIn, async (req, res) => {
  // If username is not in the token, fetch it from the database
  if (!req.user.username) {
    const userFromDb = await usermodel.findById(req.user.userId);
    if (userFromDb) {
      req.user.username = userFromDb.username;
    } else {
      // If user not found in database, redirect to home
      return res.redirect('/');
    }
  }

  // Redirect to the username-based profile URL
  res.redirect(`/profile/${req.user.username}`);
})

// New username-based profile route
app.get("/profile/:username", isLoggedIn, async (req, res) => {
  try {
    let displaydata = await usermodel.find();
    let user = await usermodel.findOne({ username: req.params.username }).populate("posts");

    // If user not found, redirect to the logged-in user's profile
    if (!user) {
      // If username is not in the token, fetch it from the database
      if (!req.user.username) {
        const userFromDb = await usermodel.findById(req.user.userId);
        if (userFromDb) {
          req.user.username = userFromDb.username;
        } else {
          // If user not found in database, redirect to home
          return res.redirect('/');
        }
      }
      return res.redirect(`/profile/${req.user.username}`);
    }

    // Get the logged-in user's full information
    const loggedInUser = await usermodel.findById(req.user.userId);

    let blogg = await postmodel.find();
    res.render('profile', {
      title: 'Profile',
      user,
      blogg,
      displaydata,
      loggedInUser,
      isOwnProfile: loggedInUser._id.toString() === user._id.toString(),
      isAdmin: loggedInUser.role === 'ADMIN'
    });
  } catch (error) {
    console.error('Error loading profile:', error);
    res.redirect('/');
  }
});

app.get('/logout', async (req, res) => {
  res.clearCookie('Token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });
  res.redirect('/');
});


app.post("/post", isLoggedIn, async (req, res) => {
  let user = await usermodel.findOne({ email: req.user.email });
  let { content } = req.body;
  let post = await postmodel.create({
    userinfo: user._id,
    content
  })

  user.posts.push(post._id)
  await user.save();
  res.redirect('/profile');
}
)
app.post('/create', async (req, res) => {
  let { username, email, age, password } = req.body;

  let user = await usermodel.findOne({ email });
  if (user) {
    res.send('<span>You must be logged in first .. <a href="/">Log In</a></span>');
  }
  else {
    bcrypt.genSalt(10, (err, salt) => {
      bcrypt.hash(password, salt, async (err, hash) => {
        // All users created through this form will be CITIZEN
        const userRole = 'CITIZEN';

        const newuserdata = await usermodel.create({
          username,
          name: username,
          age,
          email,
          password: hash,
          role: userRole
        })
        let token = jwt.sign({ email: email, role: userRole }, "shhh");
        res.cookie("Token", token);
        res.redirect('/profile');
      })
    })
  }
})
app.post('/login', async (req, res) => {
  let { email, password, remember } = req.body;
  let user = await usermodel.findOne({ email });
  if (user) {
    let verify = bcrypt.compare(password, user.password, (err, result) => {
      if (result) {
        // Set token expiration based on "Remember Me" checkbox
        const expiresIn = remember ? '30d' : '1d';
        let token = jwt.sign({
          email: email,
          role: user.role,
          userId: user._id,
          username: user.username
        }, "shhh", { expiresIn });

        // Set cookie with secure options
        res.cookie("Token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production', // Only send over HTTPS in production
          sameSite: 'strict',
          maxAge: remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000 // 30 days or 1 day
        });

        res.redirect('/profile');
      }
      else {
        res.send("Incorrect Credentials. Verify your email and password");
      }
    });
  }
  else {
    res.send('<span>No such User Exists Create one ? .. <a href="/">Create</a></span>');
  }
})

function isLoggedIn(req, res, next) {
  if (!req.cookies.Token || req.cookies.Token === "") {
    // For API responses
    if (req.xhr || req.path.includes('/api/')) {
      return res.status(401).json({ error: 'You must be logged in to access this resource' });
    }

    // Check if the request is for complaints page specifically
    if (req.path === '/complaints') {
      return res.render('login', {
        title: 'Login',
        error: 'Please login first to register a complaint'
      });
    }

    // Generic message for other protected routes
    return res.render('login', {
      title: 'Login',
      error: 'You must be logged in to access this resource'
    });
  }

  try {
    let data = jwt.verify(req.cookies.Token, "shhh");
    console.log('JWT token verified, user data:', data);

    // Make sure the user object has all required fields
    if (!data.userId) {
      console.error('JWT token missing userId:', data);
      res.clearCookie('Token');
      return res.render('login', {
        title: 'Login',
        error: 'Your session is invalid. Please login again.'
      });
    }

    // Set the user data in the request object
    req.user = {
      userId: data.userId,
      email: data.email,
      role: data.role,
      username: data.username
    };

    next();
  } catch (error) {
    // JWT verification failed
    console.error('JWT verification error:', error);
    res.clearCookie('Token');
    return res.render('login', {
      title: 'Login',
      error: 'Your session has expired. Please login again.'
    });
  }
}

// Role-based middleware functions
function isAdmin(req, res, next) {
  if (req.user && req.user.role === 'ADMIN') {
    next();
  } else {
    res.send('<span>Access denied. Admin privileges required. <a href="/">Go Back</a></span>');
  }
}

function isOfficer(req, res, next) {
  if (req.user && (req.user.role === 'ADMIN' || req.user.role === 'OFFICER')) {
    next();
  } else {
    res.send('<span>Access denied. Officer privileges required. <a href="/">Go Back</a></span>');
  }
}

function isCitizen(req, res, next) {
  if (req.user && (req.user.role === 'ADMIN' || req.user.role === 'OFFICER' || req.user.role === 'CITIZEN')) {
    next();
  } else {
    res.send('<span>Access denied. Citizen privileges required. <a href="/">Go Back</a></span>');
  }
}

app.get('/home', (req, res) => {
  res.render('home', { title: 'Home' });
}
)

app.get('/login', (req, res) => {
  res.render('login', { title: 'Login' });
}
)

app.get('/currentStatus', (req, res) => {
  // Pass an empty applications array for now
  res.render('currentStatus', { title: 'Application Status', applications: [] });
});

// Complaints routes
app.get('/complaints', isLoggedIn, (req, res) => {
  res.render('file-complaint', {
    title: 'File a Complaint', categories: [
      'INFRASTRUCTURE', 'WATER_SUPPLY', 'ELECTRICITY', 'SANITATION',
      'HEALTHCARE', 'EDUCATION', 'TRANSPORTATION', 'OTHER'
    ]
  });
});

// Add this function before the complaint creation route
function generateTrackingId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 5);
  return `GRV-${timestamp}-${random}`.toUpperCase();
}

app.post('/complaints', isLoggedIn, async (req, res) => {
  try {
    const { title, description, state, city, specific_location } = req.body;

    // Make sure we have a valid user ID
    if (!req.user.userId) {
      console.error('User object missing userId:', req.user);
      return res.render('file-complaint', {
        title: 'File a Complaint',
        error: 'Authentication error. Please try logging in again.',
        categories: ['INFRASTRUCTURE', 'WATER_SUPPLY', 'ELECTRICITY', 'SANITATION', 'HEALTHCARE', 'EDUCATION', 'TRANSPORTATION', 'OTHER']
      });
    }

    if (!description) {
      return res.render('file-complaint', {
        title: 'File a Complaint',
        error: 'Description is required for AI categorization',
        categories: ['INFRASTRUCTURE', 'WATER_SUPPLY', 'ELECTRICITY', 'SANITATION', 'HEALTHCARE', 'EDUCATION', 'TRANSPORTATION', 'OTHER']
      });
    }

    // Validate location fields
    if (!state || !city || !specific_location) {
      return res.render('file-complaint', {
        title: 'File a Complaint',
        error: 'State, city, and specific location are required',
        categories: ['INFRASTRUCTURE', 'WATER_SUPPLY', 'ELECTRICITY', 'SANITATION', 'HEALTHCARE', 'EDUCATION', 'TRANSPORTATION', 'OTHER']
      });
    }

    // Format location string
    const location = `${specific_location}, ${city}, ${state}, India`;

    // Use AI to categorize the complaint
    const category = await categorizeComplaint(description);

    // Get relevant government scheme information
    const schemeInfo = await getGovernmentSchemeInfo(category, description);

    // Generate unique tracking ID
    const trackingId = generateTrackingId();

    // Create complaint using the main Complaint model
    const complaint = new Complaint({
      title,
      description,
      location,
      userId: req.user.userId,
      category,
      status: 'PENDING',
      priority: 'medium',
      trackingId
    });

    await complaint.save();

    // Redirect with success message, tracking ID, and scheme information
    res.render('file-complaint', {
      title: 'File a Complaint',
      success: `Complaint submitted successfully! Your tracking ID is: ${trackingId}`,
      categories: ['INFRASTRUCTURE', 'WATER_SUPPLY', 'ELECTRICITY', 'SANITATION', 'HEALTHCARE', 'EDUCATION', 'TRANSPORTATION', 'OTHER'],
      schemeInfo: schemeInfo
    });
  } catch (error) {
    console.error('Error submitting complaint:', error);
    res.render('file-complaint', {
      title: 'File a Complaint',
      error: 'Failed to submit complaint. Please try again. Error: ' + error.message,
      categories: ['INFRASTRUCTURE', 'WATER_SUPPLY', 'ELECTRICITY', 'SANITATION', 'HEALTHCARE', 'EDUCATION', 'TRANSPORTATION', 'OTHER']
    });
  }
});

app.get('/my-complaints', isLoggedIn, async (req, res) => {
  try {
    // Fetch complaints for the current user using the correct user ID field
    const complaints = await Complaint.find({ userId: req.user.userId }).sort({ createdAt: -1 });

    res.render('my-complaints', {
      title: 'My Complaints',
      complaints
    });
  } catch (error) {
    console.error('Error fetching complaints:', error);
    res.status(500).render('my-complaints', {
      title: 'My Complaints',
      error: 'Error loading complaints. Please try again later.'
    });
  }
});

app.get('/complaint/:id', isLoggedIn, async (req, res) => {
  try {
    const complaint = await Complaint.findById(req.params.id);

    if (!complaint) {
      return res.status(404).send('Complaint not found');
    }

    // Check if user owns this complaint or is admin/officer
    if (complaint.userId.toString() !== req.user.userId &&
      req.user.role !== 'ADMIN' && req.user.role !== 'OFFICER') {
      return res.status(403).send('Access denied');
    }

    res.render('complaint-details', { title: 'Complaint Details', complaint });
  } catch (error) {
    console.error('Error fetching complaint details:', error);
    res.status(500).send('Error loading complaint details');
  }
});

// Admin dashboard for complaints
app.get('/admin-complaints', isLoggedIn, isOfficer, async (req, res) => {
  try {
    // Fetch all complaints using the main Complaint model
    const complaints = await Complaint.find().sort({ createdAt: -1 });

    res.render('admin-complaints', {
      title: 'Manage Complaints',
      complaints
    });
  } catch (error) {
    console.error('Error fetching complaints for admin:', error);
    res.status(500).render('admin-complaints', {
      title: 'Manage Complaints',
      error: 'Error loading complaints. Please try again later.'
    });
  }
});

app.post('/update-complaint-status', isLoggedIn, isOfficer, async (req, res) => {
  try {
    const { complaintId, status } = req.body;

    if (!complaintId || !status) {
      return res.status(400).json({ error: 'Complaint ID and status are required' });
    }

    const complaint = await Complaint.findById(complaintId);
    if (!complaint) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    // Update status and last updated timestamp
    complaint.status = status;
    complaint.updatedAt = new Date();

    await complaint.save();

    // Redirect back to the admin dashboard
    res.redirect('/admin');
  } catch (error) {
    console.error('Error updating complaint status:', error);
    res.status(500).json({ error: 'Failed to update complaint status' });
  }
});

// Admin dashboard route
app.get('/admin', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const officers = await usermodel.find({ role: 'OFFICER' });
    const citizens = await usermodel.find({ role: 'CITIZEN' });

    // Fetch all complaints using the main Complaint model
    const complaints = await Complaint.find().sort({ createdAt: -1 });

    // Transform complaints to include category field
    const transformedComplaints = complaints.map(complaint => ({
      ...complaint.toObject(),
      category: complaint.category || 'OTHER' // Use category field as category, fallback to 'OTHER'
    }));

    res.render('admin-dashboard', {
      title: 'Admin Dashboard',
      officers,
      citizens,
      complaints: transformedComplaints
    });
  } catch (error) {
    console.error('Error fetching admin dashboard data:', error);
    res.status(500).render('admin-dashboard', {
      title: 'Admin Dashboard',
      error: 'Error loading dashboard data. Please try again later.'
    });
  }
});

// Create officer route
app.get('/create-officer', isLoggedIn, isAdmin, (req, res) => {
  res.render('create-officer', { title: 'Create Officer' });
});

app.post('/create-officer', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const { username, email, age, password } = req.body;

    // Check if user already exists
    const existingUser = await usermodel.findOne({ email });
    if (existingUser) {
      return res.render('create-officer', {
        title: 'Create Officer',
        error: 'Email already registered'
      });
    }

    // Create new officer account
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    await usermodel.create({
      username,
      name: username,
      age,
      email,
      password: hash,
      role: 'OFFICER'
    });

    res.redirect('/admin');
  } catch (error) {
    console.error('Error creating officer:', error);
    res.render('create-officer', {
      title: 'Create Officer',
      error: 'Error creating officer account'
    });
  }
});

// Delete user route
app.post('/delete-user/:userId', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const userId = req.params.userId;

    // Prevent deleting the last admin
    const userToDelete = await usermodel.findById(userId);
    if (!userToDelete) {
      return res.status(404).send('User not found');
    }

    if (userToDelete.role === 'ADMIN') {
      const adminCount = await usermodel.countDocuments({ role: 'ADMIN' });
      if (adminCount <= 1) {
        return res.status(400).send('Cannot delete the last admin account');
      }
    }

    await usermodel.findByIdAndDelete(userId);
    res.redirect('/admin');
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).send('Error deleting user');
  }
});

// Track application status route
app.post('/track-status', async (req, res) => {
  try {
    const { trackingId } = req.body;

    // Find the complaint by tracking ID
    const complaint = await Complaint.findOne({ trackingId });

    if (complaint) {
      // Render the application status page with the found complaint
      res.render('application-status', {
        title: 'Complaint Status',
        complaint: {
          id: complaint.trackingId,
          type: complaint.category.replace('_', ' '),
          description: complaint.description,
          status: complaint.status,
          submittedDate: complaint.createdAt,
          lastUpdated: complaint.updatedAt,
          title: complaint.title,
          location: complaint.location,
          priority: complaint.priority
        }
      });
    } else {
      // If no complaint is found, redirect back to home with an error message
      res.render('home', {
        title: 'Home',
        error: 'No complaint found with the provided tracking ID. Please check your tracking ID and try again.'
      });
    }
  } catch (error) {
    console.error('Error tracking complaint status:', error);
    res.render('home', {
      title: 'Home',
      error: 'An error occurred while tracking your complaint. Please try again later.'
    });
  }
});

// Chat route
app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get the Gemini 2.0 Flash model
    const flashModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // Create a system prompt with information about the portal
    const systemPrompt = `You are a helpful assistant for the Government Complaint Portal. Here's what you need to know:

1. Portal Features:
- User Authentication: Citizens can register and login
- Complaint Management: Users can file, track, and view complaint history
- Admin Dashboard: For managing user accounts and complaints
- Modern UI: Built with Tailwind CSS

2. User Roles:
- Citizens: Can file and track complaints
- Officers: Can manage and respond to complaints
- Admins: Can manage all aspects of the system

3. Complaint Features:
- Categorization of complaints
- Priority levels
- Status tracking
- Comment and update system

4. Tech Stack:
- Backend: Node.js, Express.js, MongoDB
- Frontend: EJS Templates, Tailwind CSS
- Authentication: JWT, Bcrypt

5. Default Accounts:
- Admin: admin@example.com / admin123
- Citizens: Register through signup page

Please help users with:
- Understanding how to file complaints
- Tracking complaint status
- Explaining the portal's features
- Guiding them through the registration process
- Answering questions about the system

User's message: "${message}"`;

    // Generate content with the system prompt and user message
    const chatResult = await flashModel.generateContent(systemPrompt);
    const chatResponse = await chatResult.response;
    const text = chatResponse.text();

    if (!text) {
      throw new Error('No response generated');
    }

    res.json({ response: text });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'I apologize, but I encountered an error processing your request. Please try again in a moment.',
      details: error.message
    });
  }
});

// Route to get government scheme information by category
app.get('/api/schemes/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const { description } = req.query;

    // Validate category
    const validCategories = ['INFRASTRUCTURE', 'WATER_SUPPLY', 'ELECTRICITY', 'SANITATION', 'HEALTHCARE', 'EDUCATION', 'TRANSPORTATION', 'OTHER'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    // Get scheme information
    const schemeInfo = await getGovernmentSchemeInfo(category, description || '');

    res.json(schemeInfo);
  } catch (error) {
    console.error('Error getting scheme information:', error);
    res.status(500).json({
      error: 'An error occurred while fetching scheme information',
      details: error.message
    });
  }
});

app.listen(3000);