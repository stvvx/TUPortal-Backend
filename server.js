require('dotenv').config();

const dns = require('node:dns');
// Use public DNS to ensure MongoDB Atlas SRV resolution works reliably across network setups
try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {
  // If restricted, fallback to default system DNS
}

const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const port = Number(process.env.PORT) || 3000;
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || 'itproflms';
const jwtSecret = process.env.JWT_SECRET || 'itproflms_jwt_secret_fallback_2026';
const lessonUploadDirectory = path.join(__dirname, 'uploads', 'lessons');
const execFileAsync = promisify(execFile);
fs.mkdirSync(lessonUploadDirectory, { recursive: true });
const lessonUpload = multer({
  storage: multer.diskStorage({
    destination: lessonUploadDirectory,
    filename: (req, file, callback) => {
      const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      callback(null, `${Date.now()}-${safeName}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!['.pdf', '.pptx'].includes(extension)) {
      return callback(new Error('Only PDF and PPTX files are supported.'));
    }
    callback(null, true);
  }
});

async function prepareLessonFile(filePath, fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension !== '.pptx') {
    return { fileName, filePath };
  }

  const converterCandidates = [
    process.env.PPTX_CONVERTER_PATH,
    'soffice',
    ...(process.platform === 'win32'
      ? [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
      ]
      : ['/usr/bin/soffice', '/usr/local/bin/soffice'])
  ].filter(Boolean);
  const pdfFileName = `${path.basename(fileName, extension)}.pdf`;
  const pdfFilePath = path.join(lessonUploadDirectory, pdfFileName);

  try {
    let lastError;
    for (const converter of converterCandidates) {
      try {
        await execFileAsync(converter, [
          '--headless',
          '--convert-to', 'pdf',
          '--outdir', lessonUploadDirectory,
          filePath
        ], { timeout: 120000 });
        if (fs.existsSync(pdfFilePath)) break;
        lastError = new Error('The converter did not produce a PDF file.');
      } catch (error) {
        lastError = error;
      }
    }
    if (!fs.existsSync(pdfFilePath)) {
      throw lastError || new Error('No LibreOffice converter was found.');
    }
    fs.unlinkSync(filePath);
    return { fileName: pdfFileName, filePath: pdfFilePath };
  } catch (error) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    throw new Error(
      `Unable to convert PPTX to PDF. Install LibreOffice or set PPTX_CONVERTER_PATH to soffice.exe. ${error.message}`
    );
  }
}

if (!mongoUri) {
  throw new Error('MONGODB_URI is required in environment variables');
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.get('/uploads/lessons/:filename', (req, res) => {
  const requestedFile = req.params.filename;
  const safeFilename = path.basename(requestedFile);
  const filePath = path.join(lessonUploadDirectory, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Lesson file not found.' });
  }

  const extension = path.extname(safeFilename).toLowerCase();
  const mimeType = {
    '.pdf': 'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }[extension] || 'application/octet-stream';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.sendFile(filePath);
});

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const mongoClient = new MongoClient(mongoUri);
let database;
let usersCollection;
let subjectsCollection;
let enrollmentsCollection;
let assignmentsCollection;
let lessonsCollection;
let lessonCompletionsCollection;
let quizzesCollection;
let quizSubmissionsCollection;
let chatMessagesCollection;
let studentsCollection;
let facultyCollection;
let programChairsCollection;
let programsCollection;
let coursesCollection;
let sectionsCollection;
let academicSettingsCollection;

// Authentication Middleware for protected routes
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, jwtSecret, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded;
    next();
  });
}

function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'super_admin' && req.user.role !== 'super admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }

  next();
}

function requireProgramChair(req, res, next) {
  if (req.user.role !== 'program_chair') {
    return res.status(403).json({ error: 'Program chair access required' });
  }
  next();
}

function requireStudent(req, res, next) {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Student access required' });
  }
  next();
}

function requireTeachingStaff(req, res, next) {
  if (!['faculty', 'instructor', 'program_chair'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Faculty or program chair access required.' });
  }
  next();
}

function serializeLesson(lesson) {
  return {
    id: lesson._id.toString(),
    subjectId: lesson.subjectId.toString(),
    title: lesson.title,
    description: lesson.description || '',
    type: lesson.type,
    fileName: lesson.fileName || null,
    fileUrl: lesson.fileName ? `/uploads/lessons/${lesson.fileName}` : null,
    slides: lesson.slides || [],
    createdAt: lesson.createdAt,
    updatedAt: lesson.updatedAt
  };
}

function serializeQuiz(quiz, includeAnswers = false) {
  return {
    id: quiz._id.toString(),
    subjectId: quiz.subjectId.toString(),
    subjectCode: quiz.subjectCode || null,
    sectionName: quiz.sectionName || null,
    title: quiz.title,
    description: quiz.description || '',
    questions: quiz.questions.map((question) => ({
      question: question.question,
      options: question.options,
      ...(includeAnswers ? { correctOption: question.correctOption } : {})
    })),
    submission: quiz.submission || null,
    createdAt: quiz.createdAt,
    updatedAt: quiz.updatedAt
  };
}

function serializeChatMessage(message) {
  return {
    id: message._id.toString(),
    senderId: message.senderId.toString(),
    senderName: message.senderName,
    senderRole: message.senderRole,
    text: message.text,
    createdAt: message.createdAt
  };
}

function getUserNameFields(user) {
  if (user.firstName || user.middleName || user.lastName) {
    return {
      firstName: user.firstName || '',
      middleName: user.middleName || '',
      lastName: user.lastName || ''
    };
  }

  // Keep older records usable until their names are updated to structured fields.
  const tokens = (user.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: tokens[0] || '',
    middleName: tokens.length > 2 ? tokens.slice(1, -1).join(' ') : '',
    lastName: tokens.length > 1 ? tokens[tokens.length - 1] : ''
  };
}

async function serializeAuthUser(user) {
  let studentProfile = null;
  let yearSection = null;

  if ((user.role || 'student') === 'student') {
    studentProfile = await studentsCollection.findOne({ userId: user._id });
    if (studentProfile?.yearLevel && studentProfile.sectionId) {
      const section = await sectionsCollection.findOne({ _id: studentProfile.sectionId });
      if (section?.name) {
        yearSection = `${studentProfile.yearLevel} · ${section.name}`;
      }
    }
  }

  const nameFields = getUserNameFields(user);
  return {
    id: user._id.toString(),
    ...nameFields,
    name: [nameFields.firstName, nameFields.middleName, nameFields.lastName].filter(Boolean).join(' '),
    email: user.email,
    role: user.role || 'student',
    program: user.program || null,
    profilePicture: user.profilePicture || null,
    yearLevel: studentProfile?.yearLevel || null,
    yearSection,
    createdAt: user.createdAt
  };
}

async function getChatContacts(userId, role) {
  const currentUserId = new ObjectId(userId);

  if (role === 'student') {
    const [profile, enrollments] = await Promise.all([
      studentsCollection.findOne({ userId: currentUserId }, { projection: { sectionId: 1 } }),
      enrollmentsCollection.find({ studentId: currentUserId }, { projection: { subjectId: 1 } }).toArray()
    ]);
    const subjectIds = enrollments.map((enrollment) => enrollment.subjectId);
    if (!profile?.sectionId || subjectIds.length === 0) return [];

    const assignments = await assignmentsCollection.find({
      subjectId: { $in: subjectIds },
      sectionId: profile.sectionId,
      facultyId: { $ne: currentUserId }
    }).toArray();
    const facultyIds = [...new Set(assignments.map((assignment) => assignment.facultyId.toString()))]
      .map((id) => new ObjectId(id));
    if (facultyIds.length === 0) return [];

    const [faculty, subjects] = await Promise.all([
      usersCollection.find(
        { _id: { $in: facultyIds }, role: { $in: ['faculty', 'instructor', 'program_chair'] } },
        { projection: { password: 0 } }
      ).sort({ name: 1 }).toArray(),
      subjectsCollection.find({ _id: { $in: subjectIds } }).toArray()
    ]);
    const subjectsById = new Map(subjects.map((subject) => [subject._id.toString(), subject]));
    const assignmentsByFaculty = new Map();
    assignments.forEach((assignment) => {
      const subject = subjectsById.get(assignment.subjectId.toString());
      if (!subject) return;
      const key = assignment.facultyId.toString();
      const current = assignmentsByFaculty.get(key) || [];
      current.push({ id: subject._id.toString(), code: subject.code, description: subject.description });
      assignmentsByFaculty.set(key, current);
    });

    return faculty.map((member) => ({
      id: member._id.toString(),
      name: member.name,
      role: member.role,
      subjects: assignmentsByFaculty.get(member._id.toString()) || []
    }));
  }

  const assignments = await assignmentsCollection.find(
    role === 'program_chair' ? {} : { facultyId: currentUserId }
  ).toArray();
  if (assignments.length === 0) return [];

  const students = await usersCollection.find(
    { role: 'student', _id: { $ne: currentUserId } },
    { projection: { password: 0 } }
  ).sort({ name: 1 }).toArray();
  const profiles = await studentsCollection.find({
    userId: { $in: students.map((student) => student._id) }
  }).toArray();
  const profilesByUserId = new Map(profiles.map((profile) => [profile.userId.toString(), profile]));
  const eligibleStudents = [];

  for (const student of students) {
    const profile = profilesByUserId.get(student._id.toString());
    const studentEnrollments = await enrollmentsCollection.find({
      studentId: student._id,
      subjectId: { $in: assignments.map((assignment) => assignment.subjectId) }
    }, { projection: { subjectId: 1 } }).toArray();
    const subjectIds = new Set(studentEnrollments.map((enrollment) => enrollment.subjectId.toString()));
    const matchingAssignments = assignments.filter((assignment) =>
      subjectIds.has(assignment.subjectId.toString()) &&
      (!profile?.sectionId || assignment.sectionId.toString() === profile.sectionId.toString())
    );
    if (matchingAssignments.length > 0) {
      eligibleStudents.push({
        id: student._id.toString(),
        name: student.name,
        role: student.role,
        subjects: matchingAssignments.map((assignment) => ({
          id: assignment.subjectId.toString()
        }))
      });
    }
  }
  return eligibleStudents;
}

async function canChatWith(userId, role, recipientId) {
  const contacts = await getChatContacts(userId, role);
  return contacts.some((contact) => contact.id === recipientId);
}

// ----------------- ROUTES ----------------- //

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: database ? 'ok' : 'degraded',
    database: database ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Helper validation functions
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@tup\.edu\.ph$/i.test(email.trim());
}

const VALID_YEAR_LEVELS = ['First Year', 'Second Year', 'Third Year', 'Fourth Year'];
const VALID_TERMS = ['First Term', 'Second Term', 'Third Term'];
// Public: Get all programs for registration dropdown
app.get('/api/programs', async (req, res) => {
  try {
    const programs = await programsCollection.find({}).sort({ name: 1 }).toArray();
    return res.json({
      programs: programs.map((p) => ({
        id: p._id.toString(),
        name: p.name
      }))
    });
  } catch (error) {
    console.error('Error fetching programs:', error);
    return res.status(500).json({ error: 'Failed to fetch programs.' });
  }
});

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      firstName: rawFirstName,
      middleName: rawMiddleName,
      lastName: rawLastName,
      name: legacyName,
      email,
      password,
      program,
      profilePictureBase64
    } = req.body;
    const legacyTokens = typeof legacyName === 'string'
      ? legacyName.trim().split(/\s+/).filter(Boolean)
      : [];
    const firstName = typeof rawFirstName === 'string' ? rawFirstName.trim() : legacyTokens[0] || '';
    const middleName = typeof rawMiddleName === 'string'
      ? rawMiddleName.trim()
      : legacyTokens.length > 2 ? legacyTokens.slice(1, -1).join(' ') : '';
    const lastName = typeof rawLastName === 'string'
      ? rawLastName.trim()
      : legacyTokens.length > 1 ? legacyTokens[legacyTokens.length - 1] : '';
    const name = [firstName, middleName, lastName].filter(Boolean).join(' ');

    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'First name and last name are required.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please use your TUP email address ending in @tup.edu.ph.' });
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    if (!program || typeof program !== 'string' || !program.trim()) {
      return res.status(400).json({ error: 'Program is required (e.g. BSIT, BSCS).' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if user already exists
    const existingUser = await usersCollection.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Build profile picture data URI if provided
    const profilePicture = profilePictureBase64
      ? `data:image/jpeg;base64,${profilePictureBase64}`
      : null;

    const newUser = {
      name,
      firstName,
      middleName,
      lastName,
      email: normalizedEmail,
      password: hashedPassword,
      role: 'student',
      program: program.trim(),
      profilePicture,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await usersCollection.insertOne(newUser);
    const userId = result.insertedId.toString();
    await studentsCollection.insertOne({
      userId: result.insertedId,
      yearLevel: null,
      sectionId: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Generate JWT
    const token = jwt.sign(
      {
        userId,
        email: newUser.email,
        name: newUser.name,
        firstName: newUser.firstName,
        middleName: newUser.middleName,
        lastName: newUser.lastName,
        role: newUser.role
      },
      jwtSecret,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      message: 'Account created successfully',
      token,
      user: await serializeAuthUser({ ...newUser, _id: result.insertedId })
    });
  } catch (error) {
    console.error('Error during registration:', error);
    // Handle MongoDB duplicate key error code 11000
    if (error.code === 11000) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    return res.status(500).json({ error: 'Internal server error while creating account.' });
  }
});

// Login

app.post('/api/auth/login', async (req, res) => {

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Find user by email
    const user = await usersCollection.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const userId = user._id.toString();

    // Generate JWT
    const token = jwt.sign(
      {
        userId,
        email: user.email,
        name: user.name,
        role: user.role
      },
      jwtSecret,
      { expiresIn: '7d' }
    );

    return res.json({
      message: 'Login successful',
      token,
      user: await serializeAuthUser(user)
    });
  } catch (error) {
    console.error('Error during login:', error);
    return res.status(500).json({ error: 'Internal server error while logging in.' });
  }
});

// Get current authenticated user profile
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    let user;
    try {
      user = await usersCollection.findOne(
        { _id: new ObjectId(req.user.userId) },
        { projection: { password: 0 } }
      );
    } catch {
      user = await usersCollection.findOne(
        { email: req.user.email },
        { projection: { password: 0 } }
      );
    }

    if (!user) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    return res.json({ user: await serializeAuthUser(user) });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});

app.put('/api/auth/me/profile-picture', authenticateToken, async (req, res) => {
  try {
    const profilePicture = typeof req.body.profilePicture === 'string'
      ? req.body.profilePicture
      : '';
    const validImageDataUri = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(profilePicture);

    if (!validImageDataUri) {
      return res.status(400).json({ error: 'Choose a valid JPEG, PNG, or WebP profile photo.' });
    }
    if (profilePicture.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Profile photo must be smaller than 7.5 MB.' });
    }
    if (!ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({ error: 'Invalid authenticated user.' });
    }

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(req.user.userId) },
      { $set: { profilePicture, updatedAt: new Date() } }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    return res.json({ profilePicture });
  } catch (error) {
    console.error('Error saving profile picture:', error);
    return res.status(500).json({ error: 'Failed to save profile picture.' });
  }
});

// Shared authenticated chat room for students, faculty, and program chairs
app.get('/api/chat/messages', authenticateToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.query.recipientId)) {
      return res.status(400).json({ error: 'A valid chat recipient is required.' });
    }
    const recipientId = req.query.recipientId;
    if (!(await canChatWith(req.user.userId, req.user.role, recipientId))) {
      return res.status(403).json({ error: 'You are not allowed to chat with this user.' });
    }
    const senderId = new ObjectId(req.user.userId);
    const recipientObjectId = new ObjectId(recipientId);
    const messages = await chatMessagesCollection
      .find({
        $or: [
          { senderId, recipientId: recipientObjectId },
          { senderId: recipientObjectId, recipientId: senderId }
        ]
      })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();

    return res.json({
      messages: messages.map(serializeChatMessage)
    });
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    return res.status(500).json({ error: 'Failed to fetch chat messages.' });
  }
});

app.post('/api/chat/messages', authenticateToken, async (req, res) => {
  try {
    const recipientId = typeof req.body.recipientId === 'string' ? req.body.recipientId : '';
    if (!ObjectId.isValid(recipientId)) {
      return res.status(400).json({ error: 'A valid chat recipient is required.' });
    }
    if (!(await canChatWith(req.user.userId, req.user.role, recipientId))) {
      return res.status(403).json({ error: 'You are not allowed to chat with this user.' });
    }
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'Message text is required.' });
    }
    if (text.length > 1000) {
      return res.status(400).json({ error: 'Message must be 1000 characters or fewer.' });
    }

    let sender;
    try {
      sender = await usersCollection.findOne(
        { _id: new ObjectId(req.user.userId) },
        { projection: { name: 1, role: 1 } }
      );
    } catch {
      sender = null;
    }

    if (!sender) {
      return res.status(401).json({ error: 'Authenticated user profile not found.' });
    }

    const message = {
      senderId: sender._id,
      recipientId: new ObjectId(recipientId),
      senderName: sender.name,
      senderRole: sender.role || 'student',
      text,
      createdAt: new Date()
    };
    const result = await chatMessagesCollection.insertOne(message);

    return res.status(201).json({
      message: serializeChatMessage({ ...message, _id: result.insertedId })
    });
  } catch (error) {
    console.error('Error creating chat message:', error);
    return res.status(500).json({ error: 'Failed to send chat message.' });
  }
});

app.get('/api/chat/contacts', authenticateToken, async (req, res) => {
  try {
    return res.json({ contacts: await getChatContacts(req.user.userId, req.user.role) });
  } catch (error) {
    console.error('Error fetching chat contacts:', error);
    return res.status(500).json({ error: 'Failed to fetch chat contacts.' });
  }
});

app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const role = req.user.role === 'super admin' ? 'super_admin' : req.user.role;
    const [users, subjects, sections, enrollments, assignments] = await Promise.all([
      usersCollection.countDocuments({}),
      subjectsCollection.countDocuments({}),
      sectionsCollection.countDocuments({}),
      enrollmentsCollection.countDocuments({}),
      assignmentsCollection.countDocuments({})
    ]);

    if (role === 'student') {
      const studentId = new ObjectId(req.user.userId);
      const profile = await studentsCollection.findOne({ userId: studentId });
      const academicSettings = await academicSettingsCollection.findOne({ _id: 'current' });
      const currentSubjectQuery = {
        yearLevel: profile?.yearLevel,
        schoolYear: academicSettings?.schoolYear,
        term: academicSettings?.term
      };
      const availableSubjects = profile?.yearLevel
        ? await subjectsCollection.find(currentSubjectQuery).toArray()
        : [];
      const studentEnrollments = await enrollmentsCollection.find({ studentId }).toArray();
      const enrolledSubjectIds = studentEnrollments.map((item) => item.subjectId);
      const enrolledSubjects = enrolledSubjectIds.length
        ? await subjectsCollection.find({ ...currentSubjectQuery, _id: { $in: enrolledSubjectIds } }).toArray()
        : [];
      const terms = ['First Term', 'Second Term', 'Third Term'].map((term) => ({
        label: term.replace(' Term', ''),
        value: enrolledSubjects.filter((subject) => subject.term === term).length
      }));
      return res.json({
        role,
        chart: terms,
        totals: { availableSubjects: availableSubjects.length, enrolledSubjects: enrolledSubjects.length }
      });
    }

    if (role === 'faculty') {
      const facultyAssignments = await assignmentsCollection.countDocuments({
        facultyId: new ObjectId(req.user.userId)
      });
      return res.json({
        role,
        chart: [
          { label: 'Subjects', value: facultyAssignments },
          { label: 'Lessons', value: 0 },
          { label: 'Exams', value: 0 },
          { label: 'Grades', value: 0 }
        ],
        totals: { assignedSubjects: facultyAssignments }
      });
    }

    if (role === 'program_chair') {
      return res.json({
        role,
        chart: [
          { label: 'Subjects', value: subjects },
          { label: 'Sections', value: sections },
          { label: 'Assignments', value: assignments },
          { label: 'Enrollments', value: enrollments }
        ],
        totals: { subjects, sections, assignments, enrollments }
      });
    }

    return res.json({
      role,
      chart: [
        { label: 'Students', value: await usersCollection.countDocuments({ role: 'student' }) },
        { label: 'Faculty', value: await usersCollection.countDocuments({ role: { $in: ['faculty', 'instructor'] } }) },
        { label: 'Programs', value: await programsCollection.countDocuments({}) },
        { label: 'Subjects', value: subjects }
      ],
      totals: { users, subjects, sections, enrollments, assignments }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    return res.status(500).json({ error: 'Failed to fetch dashboard statistics.' });
  }
});

// Program chair subject and enrollment management
app.get('/api/program-chair/subjects', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const subjects = await subjectsCollection.find({}).sort({ code: 1 }).toArray();
    return res.json({ subjects });
  } catch (error) {
    console.error('Error fetching subjects:', error);
    return res.status(500).json({ error: 'Failed to fetch subjects.' });
  }
});

app.get('/api/program-chair/users', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const users = await usersCollection
      .find({}, { projection: { password: 0 } })
      .sort({ name: 1 })
      .toArray();
    return res.json({
      users: users.map((user) => ({
        id: user._id.toString(),
        ...getUserNameFields(user),
        name: user.name,
        email: user.email,
        role: user.role || 'student'
      }))
    });
  } catch (error) {
    console.error('Error fetching program chair users:', error);
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

app.get('/api/program-chair/students', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const students = await usersCollection.find({ role: 'student' }, { projection: { password: 0 } }).sort({ name: 1 }).toArray();
    const profiles = await studentsCollection.find({ userId: { $in: students.map((student) => student._id) } }).toArray();
    const profileByUserId = new Map(profiles.map((profile) => [profile.userId.toString(), profile]));
    return res.json({
      students: students.map((student) => {
        const profile = profileByUserId.get(student._id.toString());
        return {
          id: student._id.toString(),
          ...getUserNameFields(student),
          name: student.name,
          email: student.email,
          yearLevel: profile?.yearLevel || null,
          term: profile?.term || null,
          sectionId: profile?.sectionId?.toString() || null
        };
      })
    });
  } catch (error) {
    console.error('Error fetching program chair students:', error);
    return res.status(500).json({ error: 'Failed to fetch students.' });
  }
});

app.get('/api/program-chair/sections', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const sections = await sectionsCollection.find({}).sort({ name: 1 }).toArray();
    return res.json({ sections });
  } catch (error) {
    console.error('Error fetching sections:', error);
    return res.status(500).json({ error: 'Failed to fetch sections.' });
  }
});

// Program chair academic management (sections)
app.get('/api/program-chair/academic', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const [programs, sections, settings] = await Promise.all([
      programsCollection.find({}).sort({ name: 1 }).toArray(),
      sectionsCollection.find({}).sort({ name: 1 }).toArray(),
      academicSettingsCollection.findOne({ _id: 'current' })
    ]);
    return res.json({ programs, sections, settings: settings || null });
  } catch (error) {
    console.error('Error fetching program chair academic data:', error);
    return res.status(500).json({ error: 'Failed to fetch academic data.' });
  }
});

app.post('/api/program-chair/sections', authenticateToken, requireProgramChair, async (req, res) => {
  const { name, yearLevel, programId, courseId } = req.body;
  const targetProgramId = programId || courseId;
  const VALID_YEAR_LEVELS = ['First Year', 'Second Year', 'Third Year', 'Fourth Year'];
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Section name is required.' });
  }
  if (!yearLevel || !VALID_YEAR_LEVELS.includes(yearLevel)) {
    return res.status(400).json({ error: `Year level must be one of: ${VALID_YEAR_LEVELS.join(', ')}.` });
  }
  if (!targetProgramId || !ObjectId.isValid(targetProgramId)) {
    return res.status(400).json({ error: 'A valid program is required.' });
  }
  let prog = await programsCollection.findOne({ _id: new ObjectId(targetProgramId) });
  if (!prog) {
    prog = await coursesCollection.findOne({ _id: new ObjectId(targetProgramId) });
  }
  if (!prog) return res.status(404).json({ error: 'Program not found.' });
  try {
    const result = await sectionsCollection.insertOne({
      name: name.trim(),
      yearLevel: yearLevel.trim(),
      programId: new ObjectId(targetProgramId),
      courseId: new ObjectId(targetProgramId),
      programName: prog.name,
      createdBy: req.user.userId,
      createdAt: new Date()
    });
    return res.status(201).json({
      section: {
        id: result.insertedId.toString(),
        name: name.trim(),
        yearLevel: yearLevel.trim(),
        programId: targetProgramId,
        programName: prog.name
      }
    });
  } catch (error) {
    console.error('Error creating section:', error);
    return res.status(error.code === 11000 ? 409 : 500).json({ error: 'Failed to create section.' });
  }
});

app.patch('/api/program-chair/sections/:sectionId', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const { name, yearLevel, programId, courseId } = req.body;
    const targetProgramId = programId || courseId;
    if (!ObjectId.isValid(req.params.sectionId) || !name?.trim() || !VALID_YEAR_LEVELS.includes(yearLevel) || !ObjectId.isValid(targetProgramId)) {
      return res.status(400).json({ error: 'Valid section name, year level, and program are required.' });
    }
    const program = await programsCollection.findOne({ _id: new ObjectId(targetProgramId) })
      || await coursesCollection.findOne({ _id: new ObjectId(targetProgramId) });
    if (!program) return res.status(404).json({ error: 'Program not found.' });
    const result = await sectionsCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.sectionId) },
      {
        $set: {
          name: name.trim(),
          yearLevel,
          programId: new ObjectId(targetProgramId),
          courseId: new ObjectId(targetProgramId),
          programName: program.name,
          updatedAt: new Date()
        }
      },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Section not found.' });
    return res.json({ section: { ...result, id: result._id.toString() } });
  } catch (error) {
    console.error('Error updating section:', error);
    return res.status(error.code === 11000 ? 409 : 500).json({ error: error.code === 11000 ? 'A section with these details already exists.' : 'Failed to update section.' });
  }
});

app.delete('/api/program-chair/sections/:sectionId', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.sectionId)) return res.status(400).json({ error: 'Valid section is required.' });
    const sectionId = new ObjectId(req.params.sectionId);
    const result = await sectionsCollection.deleteOne({ _id: sectionId });
    if (!result.deletedCount) return res.status(404).json({ error: 'Section not found.' });
    await Promise.all([
      studentsCollection.updateMany({ sectionId }, { $set: { sectionId: null, updatedAt: new Date() } }),
      assignmentsCollection.deleteMany({ sectionId })
    ]);
    return res.json({ message: 'Section deleted successfully.' });
  } catch (error) {
    console.error('Error deleting section:', error);
    return res.status(500).json({ error: 'Failed to delete section.' });
  }
});

app.post('/api/program-chair/subjects', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const { code, description, yearLevel, term } = req.body;
    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';

    if (!/^[A-Z0-9-]+$/.test(normalizedCode)) {
      return res.status(400).json({ error: 'Subject code must use uppercase letters, numbers, or hyphens.' });
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'Subject description is required.' });
    }
    if (!yearLevel || typeof yearLevel !== 'string' || !yearLevel.trim()) {
      return res.status(400).json({ error: 'Year level is required.' });
    }
    if (!term || typeof term !== 'string' || !VALID_TERMS.includes(term.trim())) {
      return res.status(400).json({ error: `Semester must be one of: ${VALID_TERMS.join(', ')}.` });
    }
    const academicSettings = await academicSettingsCollection.findOne({ _id: 'current' });
    if (!academicSettings?.schoolYear) {
      return res.status(409).json({ error: 'Academic school year is not configured.' });
    }

    const subject = {
      code: normalizedCode,
      description: description.trim(),
      yearLevel: yearLevel.trim(),
      term: term.trim(),
      schoolYear: academicSettings.schoolYear,
      createdBy: req.user.userId,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const result = await subjectsCollection.insertOne(subject);
    return res.status(201).json({ subject: { ...subject, id: result.insertedId.toString() } });
  } catch (error) {
    console.error('Error creating subject:', error);
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A subject with this code already exists.' });
    }
    return res.status(500).json({ error: 'Failed to create subject.' });
  }
});

app.patch('/api/program-chair/subjects/:subjectId', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const { code, description, yearLevel, term } = req.body;
    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!ObjectId.isValid(req.params.subjectId) || !/^[A-Z0-9-]+$/.test(normalizedCode) ||
      !description?.trim() || !VALID_YEAR_LEVELS.includes(yearLevel) || !VALID_TERMS.includes(term)) {
      return res.status(400).json({ error: 'Valid subject code, description, year level, and semester are required.' });
    }
    const academicSettings = await academicSettingsCollection.findOne({ _id: 'current' });
    if (!academicSettings?.schoolYear) {
      return res.status(409).json({ error: 'Academic school year is not configured.' });
    }
    const result = await subjectsCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.subjectId) },
      { $set: { code: normalizedCode, description: description.trim(), yearLevel, term, schoolYear: academicSettings.schoolYear, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Subject not found.' });
    return res.json({ subject: { ...result, id: result._id.toString() } });
  } catch (error) {
    console.error('Error updating subject:', error);
    return res.status(error.code === 11000 ? 409 : 500).json({ error: error.code === 11000 ? 'A subject with this code already exists.' : 'Failed to update subject.' });
  }
});

app.delete('/api/program-chair/subjects/:subjectId', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.subjectId)) return res.status(400).json({ error: 'Valid subject is required.' });
    const result = await subjectsCollection.deleteOne({ _id: new ObjectId(req.params.subjectId) });
    if (!result.deletedCount) return res.status(404).json({ error: 'Subject not found.' });
    await Promise.all([
      enrollmentsCollection.deleteMany({ subjectId: new ObjectId(req.params.subjectId) }),
      assignmentsCollection.deleteMany({ subjectId: new ObjectId(req.params.subjectId) })
    ]);
    return res.json({ message: 'Subject deleted successfully.' });
  } catch (error) {
    console.error('Error deleting subject:', error);
    return res.status(500).json({ error: 'Failed to delete subject.' });
  }
});

app.get('/api/student/subjects', authenticateToken, requireStudent, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.user.userId)) {
      return res.status(400).json({ error: 'Invalid student account.' });
    }

    const studentProfile = await studentsCollection.findOne({ userId: new ObjectId(req.user.userId) });
    if (!studentProfile?.yearLevel) {
      return res.json({ yearLevel: null, subjects: [], terms: [] });
    }

    const academicSettings = await academicSettingsCollection.findOne({ _id: 'current' });
    const [subjects, enrollments] = await Promise.all([
      subjectsCollection
        .find({
          yearLevel: studentProfile.yearLevel,
          schoolYear: academicSettings?.schoolYear,
          term: academicSettings?.term
        })
        .sort({ term: 1, code: 1 })
        .toArray(),
      enrollmentsCollection
        .find({ studentId: new ObjectId(req.user.userId) }, { projection: { subjectId: 1 } })
        .toArray()
    ]);
    const enrolledSubjectIds = new Set(enrollments.map((enrollment) => enrollment.subjectId.toString()));
    const serializedSubjects = subjects.map((subject) => ({
      id: subject._id.toString(),
      code: subject.code,
      description: subject.description,
      yearLevel: subject.yearLevel,
      term: subject.term,
      enrolled: enrolledSubjectIds.has(subject._id.toString())
    }));

    return res.json({
      yearLevel: studentProfile.yearLevel,
      subjects: serializedSubjects,
      currentTerm: academicSettings?.term || null,
      terms: [...new Set(serializedSubjects.map((subject) => subject.term))]
    });
  } catch (error) {
    console.error('Error fetching student subjects:', error);
    return res.status(500).json({ error: 'Failed to fetch available subjects.' });
  }
});

app.post('/api/student/enrollments', authenticateToken, requireStudent, async (req, res) => {
  try {
    const { subjectId, term } = req.body;
    if (!ObjectId.isValid(subjectId) || typeof term !== 'string' || !term.trim()) {
      return res.status(400).json({ error: 'A valid subject and semester are required.' });
    }

    const studentId = new ObjectId(req.user.userId);
    const [studentProfile, subject, academicSettings] = await Promise.all([
      studentsCollection.findOne({ userId: studentId }),
      subjectsCollection.findOne({ _id: new ObjectId(subjectId) }),
      academicSettingsCollection.findOne({ _id: 'current' })
    ]);
    if (!studentProfile?.yearLevel) {
      return res.status(400).json({ error: 'Your year level must be assigned before enrollment.' });
    }
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found.' });
    }
    if (!academicSettings?.schoolYear || subject.schoolYear !== academicSettings.schoolYear) {
      return res.status(400).json({ error: 'This subject is not available for the current school year.' });
    }
    if (subject.term !== academicSettings.term) {
      return res.status(400).json({ error: 'You can only enroll in subjects for the current semester.' });
    }
    if (subject.yearLevel !== studentProfile.yearLevel) {
      return res.status(400).json({ error: 'You can only enroll in subjects for your year level.' });
    }
    if (subject.term !== term.trim()) {
      return res.status(400).json({ error: 'You can only enroll in subjects for the selected semester.' });
    }

    const enrollment = {
      studentId,
      subjectId: new ObjectId(subjectId),
      schoolYear: academicSettings.schoolYear,
      enrolledBy: req.user.userId,
      enrolledByRole: 'student',
      createdAt: new Date()
    };
    const result = await enrollmentsCollection.insertOne(enrollment);
    return res.status(201).json({ enrollment: { ...enrollment, id: result.insertedId.toString() } });
  } catch (error) {
    console.error('Error enrolling student:', error);
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Student is already enrolled in this subject.' });
    }
    return res.status(500).json({ error: 'Failed to enroll student.' });
  }
});

app.post('/api/program-chair/assignments', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const { facultyId, subjectId, sectionId } = req.body;
    if (!ObjectId.isValid(facultyId) || !ObjectId.isValid(subjectId) || !ObjectId.isValid(sectionId)) {
      return res.status(400).json({ error: 'Valid faculty member, subject, and section are required.' });
    }
    const faculty = await usersCollection.findOne({
      _id: new ObjectId(facultyId),
      role: { $in: ['faculty', 'instructor', 'program_chair'] }
    });
    const subject = await subjectsCollection.findOne({ _id: new ObjectId(subjectId) });
    const section = await sectionsCollection.findOne({ _id: new ObjectId(sectionId) });
    if (!faculty || !subject || !section) {
      return res.status(404).json({ error: 'Faculty member, subject, or section not found.' });
    }
    const assignment = {
      facultyId: new ObjectId(facultyId),
      subjectId: new ObjectId(subjectId),
      sectionId: new ObjectId(sectionId),
      assignedBy: req.user.userId,
      createdAt: new Date()
    };
    const result = await assignmentsCollection.insertOne(assignment);
    return res.status(201).json({ assignment: { ...assignment, id: result.insertedId.toString() } });
  } catch (error) {
    console.error('Error assigning subject:', error);
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Subject is already assigned to this faculty member.' });
    }
    return res.status(500).json({ error: 'Failed to assign subject.' });
  }
});

app.get('/api/program-chair/assignments', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const assignments = await assignmentsCollection.find({}).sort({ createdAt: -1 }).toArray();
    const facultyIds = assignments.map((assignment) => assignment.facultyId);
    const facultyUsers = await usersCollection.find({ _id: { $in: facultyIds } }, { projection: { password: 0 } }).toArray();
    const facultyById = new Map(facultyUsers.map((faculty) => [faculty._id.toString(), faculty]));

    return res.json({
      assignments: assignments.map((assignment) => {
        const faculty = facultyById.get(assignment.facultyId.toString());
        return {
          id: assignment._id.toString(),
          subjectId: assignment.subjectId.toString(),
          sectionId: assignment.sectionId.toString(),
          facultyId: assignment.facultyId.toString(),
          facultyName: faculty?.name || '',
          facultyEmail: faculty?.email || ''
        };
      })
    });
  } catch (error) {
    console.error('Error fetching program chair assignments:', error);
    return res.status(500).json({ error: 'Failed to fetch faculty assignments.' });
  }
});

app.patch('/api/program-chair/assignments/:assignmentId', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const { facultyId } = req.body;
    if (!ObjectId.isValid(req.params.assignmentId) || !ObjectId.isValid(facultyId)) {
      return res.status(400).json({ error: 'Valid assignment and faculty member are required.' });
    }
    const faculty = await usersCollection.findOne({
      _id: new ObjectId(facultyId),
      role: { $in: ['faculty', 'instructor', 'program_chair'] }
    });
    if (!faculty) return res.status(404).json({ error: 'Faculty member not found.' });

    const result = await assignmentsCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.assignmentId) },
      { $set: { facultyId: new ObjectId(facultyId), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Faculty assignment not found.' });
    return res.json({ assignment: { ...result, id: result._id.toString() } });
  } catch (error) {
    console.error('Error updating faculty assignment:', error);
    if (error.code === 11000) return res.status(409).json({ error: 'This faculty assignment already exists.' });
    return res.status(500).json({ error: 'Failed to update faculty assignment.' });
  }
});

app.delete('/api/program-chair/assignments/:assignmentId', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.assignmentId)) return res.status(400).json({ error: 'Valid assignment is required.' });
    const result = await assignmentsCollection.deleteOne({ _id: new ObjectId(req.params.assignmentId) });
    if (!result.deletedCount) return res.status(404).json({ error: 'Faculty assignment not found.' });
    return res.json({ message: 'Faculty assignment deleted successfully.' });
  } catch (error) {
    console.error('Error deleting faculty assignment:', error);
    return res.status(500).json({ error: 'Failed to delete faculty assignment.' });
  }
});

async function getTeachingAssignments(userId, role = 'faculty') {
  const assignments = await assignmentsCollection
    .find(role === 'program_chair' ? {} : { facultyId: new ObjectId(userId) })
    .sort({ createdAt: -1 })
    .toArray();
  if (assignments.length === 0) return [];

  const subjectIds = assignments.map((assignment) => assignment.subjectId);
  const sectionIds = assignments.map((assignment) => assignment.sectionId);
  const [subjects, sections] = await Promise.all([
    subjectsCollection.find({ _id: { $in: subjectIds } }).toArray(),
    sectionsCollection.find({ _id: { $in: sectionIds } }).toArray()
  ]);
  const subjectsById = new Map(subjects.map((subject) => [subject._id.toString(), subject]));
  const sectionsById = new Map(sections.map((section) => [section._id.toString(), section]));

  return assignments
    .map((assignment) => {
      const subject = subjectsById.get(assignment.subjectId.toString());
      const section = sectionsById.get(assignment.sectionId.toString());
      if (!subject || !section) return null;
      return {
        id: subject._id.toString(),
        code: subject.code,
        description: subject.description,
        yearLevel: subject.yearLevel,
        term: subject.term,
        sectionId: section._id.toString(),
        sectionName: section.name
      };
    })
    .filter(Boolean);
}

async function hasTeachingAssignment(userId, subjectId, role = 'faculty') {
  const query = {
    subjectId: new ObjectId(subjectId)
  };
  if (role !== 'program_chair') query.facultyId = new ObjectId(userId);
  return assignmentsCollection.findOne(query);
}

app.get('/api/teaching/subjects', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    return res.json({ subjects: await getTeachingAssignments(req.user.userId, req.user.role) });
  } catch (error) {
    console.error('Error fetching teaching subjects:', error);
    return res.status(500).json({ error: 'Failed to fetch assigned subjects.' });
  }
});

app.get('/api/teaching/subjects/:subjectId/students', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.subjectId)) {
      return res.status(400).json({ error: 'Valid subject is required.' });
    }
    if (!ObjectId.isValid(req.query.sectionId)) {
      return res.status(400).json({ error: 'Valid section is required.' });
    }

    const subjectId = new ObjectId(req.params.subjectId);
    const sectionId = new ObjectId(req.query.sectionId);
    const assignment = await assignmentsCollection.findOne({
      subjectId,
      sectionId,
      ...(req.user.role === 'program_chair' ? {} : { facultyId: new ObjectId(req.user.userId) })
    });
    if (!assignment) {
      return res.status(403).json({ error: 'You can only view students for assigned subjects.' });
    }

    const enrollments = await enrollmentsCollection.find(
      { subjectId },
      { projection: { studentId: 1 } }
    ).toArray();
    const studentIds = enrollments
      .map((enrollment) => enrollment.studentId)
      .filter((studentId) => studentId instanceof ObjectId);
    if (studentIds.length === 0) return res.json({ students: [] });

    const [users, profiles] = await Promise.all([
      usersCollection.find(
        { _id: { $in: studentIds }, role: 'student' },
        { projection: { password: 0 } }
      ).toArray(),
      studentsCollection.find(
        { userId: { $in: studentIds } },
        { projection: { userId: 1, sectionId: 1 } }
      ).toArray()
    ]);
    const profilesByUserId = new Map(profiles.map((profile) => [profile.userId.toString(), profile]));

    const students = users.filter((student) => {
      const profile = profilesByUserId.get(student._id.toString());
      return profile?.sectionId?.toString() === sectionId.toString();
    }).map((student) => {
      const nameFields = getUserNameFields(student);
      const profile = profilesByUserId.get(student._id.toString());
      return {
        id: student._id.toString(),
        ...nameFields,
        name: student.name || [nameFields.firstName, nameFields.middleName, nameFields.lastName].filter(Boolean).join(' '),
        sectionId: profile?.sectionId?.toString() || null
      };
    }).sort((a, b) =>
      a.lastName.localeCompare(b.lastName, undefined, { sensitivity: 'base' }) ||
      a.firstName.localeCompare(b.firstName, undefined, { sensitivity: 'base' }) ||
      a.middleName.localeCompare(b.middleName, undefined, { sensitivity: 'base' })
    );

    return res.json({ students });
  } catch (error) {
    console.error('Error fetching enrolled students for teaching subject:', error);
    return res.status(500).json({ error: 'Failed to fetch enrolled students.' });
  }
});

app.get('/api/teaching/lessons', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    const assignments = await getTeachingAssignments(req.user.userId);
    const subjectIds = assignments.map((subject) => new ObjectId(subject.id));
    const lessons = subjectIds.length
      ? await lessonsCollection.find({ subjectId: { $in: subjectIds } }).sort({ updatedAt: -1 }).toArray()
      : [];
    return res.json({ lessons: lessons.map(serializeLesson) });
  } catch (error) {
    console.error('Error fetching teaching lessons:', error);
    return res.status(500).json({ error: 'Failed to fetch lessons.' });
  }
});

app.get('/api/teaching/quizzes', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    const assignments = await getTeachingAssignments(req.user.userId, req.user.role);
    const subjectIds = assignments.map((subject) => new ObjectId(subject.id));
    const quizzes = subjectIds.length
      ? await quizzesCollection.find({ subjectId: { $in: subjectIds } }).sort({ updatedAt: -1 }).toArray()
      : [];
    const assignmentBySubject = new Map(assignments.map((subject) => [subject.id, subject]));
    return res.json({
      quizzes: quizzes.map((quiz) => {
        const assignment = assignmentBySubject.get(quiz.subjectId.toString());
        return serializeQuiz({
          ...quiz,
          subjectCode: assignment?.code,
          sectionName: assignment?.sectionName
        }, true);
      })
    });
  } catch (error) {
    console.error('Error fetching teaching quizzes:', error);
    return res.status(500).json({ error: 'Failed to fetch quizzes.' });
  }
});

app.post('/api/teaching/quizzes', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    const { subjectId, title, description, questions } = req.body;
    if (!ObjectId.isValid(subjectId) || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'A valid subject and quiz title are required.' });
    }
    if (!Array.isArray(questions) || questions.length < 10 || questions.length > 20) {
      return res.status(400).json({ error: 'A quiz must contain between 10 and 20 questions.' });
    }
    if (!await hasTeachingAssignment(req.user.userId, subjectId, req.user.role)) {
      return res.status(403).json({ error: 'You can only create quizzes for assigned subjects.' });
    }

    const normalizedQuestions = questions.map((question) => ({
      question: typeof question?.question === 'string' ? question.question.trim() : '',
      options: Array.isArray(question?.options)
        ? question.options.map((option) => typeof option === 'string' ? option.trim() : '')
        : [],
      correctOption: question?.correctOption
    }));
    const invalidQuestion = normalizedQuestions.some((question) =>
      !question.question ||
      question.options.length !== 4 ||
      question.options.some((option) => !option) ||
      !Number.isInteger(question.correctOption) ||
      question.correctOption < 0 ||
      question.correctOption > 3
    );
    if (invalidQuestion) {
      return res.status(400).json({
        error: 'Each question needs text, exactly four non-empty options, and a valid correct answer.'
      });
    }

    const assignmentQuery = { subjectId: new ObjectId(subjectId) };
    if (req.user.role !== 'program_chair') {
      assignmentQuery.facultyId = new ObjectId(req.user.userId);
    }
    const assignment = await assignmentsCollection.findOne(assignmentQuery);
    const subject = await subjectsCollection.findOne({ _id: new ObjectId(subjectId) });
    const section = assignment ? await sectionsCollection.findOne({ _id: assignment.sectionId }) : null;
    const now = new Date();
    const quiz = {
      subjectId: new ObjectId(subjectId),
      title: title.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      questions: normalizedQuestions,
      createdBy: new ObjectId(req.user.userId),
      createdAt: now,
      updatedAt: now
    };
    const result = await quizzesCollection.insertOne(quiz);
    return res.status(201).json({
      quiz: serializeQuiz({
        ...quiz,
        _id: result.insertedId,
        subjectCode: subject?.code,
        sectionName: section?.name
      }, true)
    });
  } catch (error) {
    console.error('Error creating quiz:', error);
    return res.status(500).json({ error: 'Failed to create quiz.' });
  }
});

app.get('/api/teaching/quizzes/:quizId/submissions', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.quizId)) {
      return res.status(400).json({ error: 'Valid quiz is required.' });
    }

    const quiz = await quizzesCollection.findOne({ _id: new ObjectId(req.params.quizId) });
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found.' });
    }

    if (!await hasTeachingAssignment(req.user.userId, quiz.subjectId.toString(), req.user.role)) {
      return res.status(403).json({ error: 'You can only view submissions for your assigned subjects.' });
    }

    const submissions = await quizSubmissionsCollection
      .find({ quizId: quiz._id })
      .sort({ submittedAt: -1 })
      .toArray();

    const studentIds = submissions.map((submission) => submission.studentId);
    const students = studentIds.length
      ? await usersCollection.find({ _id: { $in: studentIds } }, { projection: { password: 0 } }).toArray()
      : [];
    const studentsById = new Map(students.map((student) => [student._id.toString(), student]));

    return res.json({
      quiz: {
        id: quiz._id.toString(),
        title: quiz.title,
        subjectId: quiz.subjectId.toString(),
        totalQuestions: quiz.questions.length
      },
      submissions: submissions.map((submission) => ({
        id: submission._id.toString(),
        studentId: submission.studentId.toString(),
        studentName: studentsById.get(submission.studentId.toString())?.name || 'Unknown student',
        ...getUserNameFields(studentsById.get(submission.studentId.toString()) || { name: 'Unknown student' }),
        score: submission.score,
        total: submission.total,
        percentage: submission.percentage,
        submittedAt: submission.submittedAt
      }))
    });
  } catch (error) {
    console.error('Error fetching quiz submissions:', error);
    return res.status(500).json({ error: 'Failed to fetch quiz submissions.' });
  }
});

app.post('/api/teaching/lessons', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    const { subjectId, title, description, slides } = req.body;
    if (!ObjectId.isValid(subjectId) || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'A valid subject and lesson title are required.' });
    }
    if (!Array.isArray(slides) || slides.length === 0) {
      return res.status(400).json({ error: 'At least one lesson slide is required.' });
    }
    if (!await hasTeachingAssignment(req.user.userId, subjectId)) {
      return res.status(403).json({ error: 'You can only create lessons for assigned subjects.' });
    }
    const now = new Date();
    const lesson = {
      subjectId: new ObjectId(subjectId),
      title: title.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      type: 'slides',
      slides: slides.map((slide) => ({
        title: typeof slide?.title === 'string' ? slide.title.trim() : '',
        body: typeof slide?.body === 'string' ? slide.body.trim() : ''
      })).filter((slide) => slide.title || slide.body),
      createdBy: new ObjectId(req.user.userId),
      createdAt: now,
      updatedAt: now
    };
    if (lesson.slides.length === 0) {
      return res.status(400).json({ error: 'Slides must contain a title or content.' });
    }
    const result = await lessonsCollection.insertOne(lesson);
    return res.status(201).json({ lesson: serializeLesson({ ...lesson, _id: result.insertedId }) });
  } catch (error) {
    console.error('Error creating lesson:', error);
    return res.status(500).json({ error: 'Failed to create lesson.' });
  }
});

app.post('/api/teaching/lessons/upload-base64', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    const { subjectId, title, description, base64, fileName, mimeType } = req.body;
    if (!ObjectId.isValid(subjectId) || typeof title !== 'string' || !title.trim() || typeof base64 !== 'string' || !base64.trim()) {
      return res.status(400).json({ error: 'A valid subject, lesson title, and file payload are required.' });
    }
    if (!await hasTeachingAssignment(req.user.userId, subjectId)) {
      return res.status(403).json({ error: 'You can only upload lessons for assigned subjects.' });
    }

    const extension = path.extname(fileName || '').toLowerCase();
    const allowedExtensions = ['.pdf', '.pptx'];
    if (!allowedExtensions.includes(extension)) {
      return res.status(400).json({ error: 'Only PDF and PPTX files are supported.' });
    }

    const safeName = `${Date.now()}-${(fileName || 'lesson').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const buffer = Buffer.from(base64, 'base64');
    const uploadedPath = path.join(lessonUploadDirectory, safeName);
    fs.writeFileSync(uploadedPath, buffer);
    const preparedFile = await prepareLessonFile(uploadedPath, safeName);

    const now = new Date();
    const lesson = {
      subjectId: new ObjectId(subjectId),
      title: title.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      type: 'file',
      fileName: preparedFile.fileName,
      slides: [],
      createdBy: new ObjectId(req.user.userId),
      createdAt: now,
      updatedAt: now
    };

    const result = await lessonsCollection.insertOne(lesson);
    return res.status(201).json({ lesson: serializeLesson({ ...lesson, _id: result.insertedId }) });
  } catch (error) {
    console.error('Error creating uploaded lesson from base64:', error);
    return res.status(500).json({ error: error.message || 'Failed to save uploaded lesson.' });
  }
});

app.post('/api/teaching/lessons/upload', authenticateToken, requireTeachingStaff, (req, res) => {
  lessonUpload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      console.error('Lesson upload error:', uploadError);
      return res.status(400).json({ error: uploadError.message || 'Failed to upload lesson file.' });
    }
    try {
      const { subjectId, title, description } = req.body;
      if (!ObjectId.isValid(subjectId) || typeof title !== 'string' || !title.trim() || !req.file) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'A valid subject, lesson title, and file are required.' });
      }
      if (!await hasTeachingAssignment(req.user.userId, subjectId)) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'You can only upload lessons for assigned subjects.' });
      }
      const now = new Date();
      const preparedFile = await prepareLessonFile(req.file.path, req.file.filename);
      const lesson = {
        subjectId: new ObjectId(subjectId),
        title: title.trim(),
        description: typeof description === 'string' ? description.trim() : '',
        type: 'file',
        fileName: preparedFile.fileName,
        slides: [],
        createdBy: new ObjectId(req.user.userId),
        createdAt: now,
        updatedAt: now
      };
      const result = await lessonsCollection.insertOne(lesson);
      return res.status(201).json({ lesson: serializeLesson({ ...lesson, _id: result.insertedId }) });
    } catch (error) {
      console.error('Error creating uploaded lesson:', error);
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: error.message || 'Failed to save uploaded lesson.' });
    }
  });
});

app.patch('/api/teaching/lessons/:lessonId/upload-base64', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    const { base64, fileName, mimeType } = req.body;
    if (!ObjectId.isValid(req.params.lessonId) || typeof base64 !== 'string' || !base64.trim()) {
      return res.status(400).json({ error: 'Valid lesson and file payload are required.' });
    }
    const lesson = await lessonsCollection.findOne({ _id: new ObjectId(req.params.lessonId) });
    if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });
    if (!await hasTeachingAssignment(req.user.userId, lesson.subjectId.toString())) {
      return res.status(403).json({ error: 'You can only edit lessons for assigned subjects.' });
    }

    const extension = path.extname(fileName || '').toLowerCase();
    if (!['.pdf', '.pptx'].includes(extension)) {
      return res.status(400).json({ error: 'Only PDF and PPTX files are supported.' });
    }

    const safeName = `${Date.now()}-${(fileName || 'lesson').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const buffer = Buffer.from(base64, 'base64');
    const uploadedPath = path.join(lessonUploadDirectory, safeName);
    fs.writeFileSync(uploadedPath, buffer);
    const preparedFile = await prepareLessonFile(uploadedPath, safeName);

    if (lesson.fileName) {
      const oldFilePath = path.join(lessonUploadDirectory, lesson.fileName);
      if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
    }

    const updates = {
      fileName: preparedFile.fileName,
      type: 'file',
      slides: [],
      updatedAt: new Date()
    };
    await lessonsCollection.updateOne({ _id: lesson._id }, { $set: updates });
    return res.json({ lesson: serializeLesson({ ...lesson, ...updates }) });
  } catch (error) {
    console.error('Error replacing lesson file from base64:', error);
    return res.status(500).json({ error: error.message || 'Failed to replace lesson file.' });
  }
});

app.patch('/api/teaching/lessons/:lessonId', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.lessonId)) {
      return res.status(400).json({ error: 'Valid lesson is required.' });
    }
    const lesson = await lessonsCollection.findOne({ _id: new ObjectId(req.params.lessonId) });
    if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });
    if (!await hasTeachingAssignment(req.user.userId, lesson.subjectId.toString())) {
      return res.status(403).json({ error: 'You can only edit lessons for assigned subjects.' });
    }
    const updates = {};
    if (typeof req.body.title === 'string' && req.body.title.trim()) updates.title = req.body.title.trim();
    if (typeof req.body.description === 'string') updates.description = req.body.description.trim();
    if (Array.isArray(req.body.slides)) {
      updates.slides = req.body.slides
        .map((slide) => ({
          title: typeof slide?.title === 'string' ? slide.title.trim() : '',
          body: typeof slide?.body === 'string' ? slide.body.trim() : ''
        }))
        .filter((slide) => slide.title || slide.body);
      if (lesson.type === 'slides' && updates.slides.length === 0) {
        return res.status(400).json({ error: 'Slides must contain a title or content.' });
      }
    }
    if (!updates.title && !updates.description && !updates.slides) {
      return res.status(400).json({ error: 'A lesson title, description, or slides update is required.' });
    }
    updates.updatedAt = new Date();
    await lessonsCollection.updateOne({ _id: lesson._id }, { $set: updates });
    return res.json({ lesson: serializeLesson({ ...lesson, ...updates }) });
  } catch (error) {
    console.error('Error updating lesson:', error);
    return res.status(500).json({ error: 'Failed to update lesson.' });
  }
});

app.patch('/api/teaching/lessons/:lessonId/upload', authenticateToken, requireTeachingStaff, (req, res) => {
  lessonUpload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      console.error('Lesson replacement upload error:', uploadError);
      return res.status(400).json({ error: uploadError.message || 'Failed to upload replacement file.' });
    }
    try {
      if (!ObjectId.isValid(req.params.lessonId) || !req.file) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Valid lesson and replacement file are required.' });
      }
      const lesson = await lessonsCollection.findOne({ _id: new ObjectId(req.params.lessonId) });
      if (!lesson) {
        fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: 'Lesson not found.' });
      }
      if (!await hasTeachingAssignment(req.user.userId, lesson.subjectId.toString())) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'You can only edit lessons for assigned subjects.' });
      }
      const preparedFile = await prepareLessonFile(req.file.path, req.file.filename);
      const updates = {
        fileName: preparedFile.fileName,
        type: 'file',
        slides: [],
        updatedAt: new Date()
      };
      await lessonsCollection.updateOne({ _id: lesson._id }, { $set: updates });
      if (lesson.fileName) {
        const oldFilePath = path.join(lessonUploadDirectory, lesson.fileName);
        if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
      }
      return res.json({ lesson: serializeLesson({ ...lesson, ...updates }) });
    } catch (error) {
      console.error('Error replacing lesson file:', error);
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: error.message || 'Failed to replace lesson file.' });
    }
  });
});

app.delete('/api/teaching/lessons/:lessonId', authenticateToken, requireTeachingStaff, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.lessonId)) {
      return res.status(400).json({ error: 'Valid lesson is required.' });
    }
    const lesson = await lessonsCollection.findOne({ _id: new ObjectId(req.params.lessonId) });
    if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });
    if (!await hasTeachingAssignment(req.user.userId, lesson.subjectId.toString())) {
      return res.status(403).json({ error: 'You can only delete lessons for assigned subjects.' });
    }
    await lessonsCollection.deleteOne({ _id: lesson._id });
    if (lesson.fileName) {
      const filePath = path.join(lessonUploadDirectory, lesson.fileName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    return res.json({ message: 'Lesson deleted successfully.' });
  } catch (error) {
    console.error('Error deleting lesson:', error);
    return res.status(500).json({ error: 'Failed to delete lesson.' });
  }
});

app.get('/api/student/lessons', authenticateToken, requireStudent, async (req, res) => {
  try {
    const studentId = new ObjectId(req.user.userId);
    const academicSettings = await academicSettingsCollection.findOne({ _id: 'current' });
    const enrollments = await enrollmentsCollection.find({ studentId }).toArray();
    const enrolledSubjectIds = enrollments.map((enrollment) => enrollment.subjectId);
    const currentSubjects = enrolledSubjectIds.length
      ? await subjectsCollection.find({
          _id: { $in: enrolledSubjectIds },
          schoolYear: academicSettings?.schoolYear,
          term: academicSettings?.term
        }, { projection: { _id: 1 } }).toArray()
      : [];
    const subjectIds = currentSubjects.map((subject) => subject._id);
    const lessons = subjectIds.length
      ? await lessonsCollection.find({ subjectId: { $in: subjectIds } }).sort({ updatedAt: -1 }).toArray()
      : [];
    const completions = lessons.length
      ? await lessonCompletionsCollection.find({
          studentId,
          lessonId: { $in: lessons.map((lesson) => lesson._id) }
        }).toArray()
      : [];
    const completedByLessonId = new Map(
      completions.map((completion) => [completion.lessonId.toString(), completion])
    );
    return res.json({
      lessons: lessons.map((lesson) => {
        const completion = completedByLessonId.get(lesson._id.toString());
        return {
          ...serializeLesson(lesson),
          completed: Boolean(completion?.completed),
          completedAt: completion?.completedAt || null
        };
      })
    });
  } catch (error) {
    console.error('Error fetching student lessons:', error);
    return res.status(500).json({ error: 'Failed to fetch lessons.' });
  }
});

app.put('/api/student/lessons/:lessonId/completion', authenticateToken, requireStudent, async (req, res) => {
  try {
    const { lessonId } = req.params;
    const { completed } = req.body;
    if (!ObjectId.isValid(lessonId) || typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'A valid lesson and completion status are required.' });
    }

    const studentId = new ObjectId(req.user.userId);
    const lessonObjectId = new ObjectId(lessonId);
    const lesson = await lessonsCollection.findOne({ _id: lessonObjectId });
    if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });

    const enrollment = await enrollmentsCollection.findOne({
      studentId,
      subjectId: lesson.subjectId
    });
    if (!enrollment) {
      return res.status(403).json({ error: 'You must be enrolled in this lesson subject.' });
    }

    const completedAt = completed ? new Date() : null;
    await lessonCompletionsCollection.updateOne(
      { studentId, lessonId: lessonObjectId },
      {
        $set: { completed, completedAt, updatedAt: new Date() },
        $setOnInsert: { studentId, lessonId: lessonObjectId, createdAt: new Date() }
      },
      { upsert: true }
    );

    return res.json({ completed, completedAt });
  } catch (error) {
    console.error('Error updating lesson completion:', error);
    return res.status(500).json({ error: 'Failed to update lesson completion.' });
  }
});

app.get('/api/student/quizzes', authenticateToken, requireStudent, async (req, res) => {
  try {
    const rawUserId = req.user.userId;
    const studentIdObj = ObjectId.isValid(rawUserId) ? new ObjectId(rawUserId) : null;
    const studentIdFilters = studentIdObj ? [studentIdObj, rawUserId.toString()] : [rawUserId.toString()];
    const academicSettings = await academicSettingsCollection.findOne({ _id: 'current' });

    const enrollments = await enrollmentsCollection.find({
      studentId: { $in: studentIdFilters }
    }).toArray();

    const enrolledSubjectIds = enrollments
      .filter((enrollment) => enrollment.subjectId)
      .map((enrollment) => ObjectId.isValid(enrollment.subjectId)
        ? new ObjectId(enrollment.subjectId)
        : enrollment.subjectId);
    const currentSubjects = enrolledSubjectIds.length
      ? await subjectsCollection.find({
          _id: { $in: enrolledSubjectIds },
          schoolYear: academicSettings?.schoolYear,
          term: academicSettings?.term
        }).toArray()
      : [];
    const subjectIdList = [];
    currentSubjects.forEach((subject) => {
      subjectIdList.push(subject._id, subject._id.toString());
    });

    const quizzes = subjectIdList.length
      ? await quizzesCollection.find({ subjectId: { $in: subjectIdList } }).sort({ updatedAt: -1 }).toArray()
      : [];

    const quizIdList = [];
    quizzes.forEach((q) => {
      if (q._id) {
        quizIdList.push(q._id);
        quizIdList.push(q._id.toString());
      }
    });

    const submissions = quizIdList.length
      ? await quizSubmissionsCollection.find({
          studentId: { $in: studentIdFilters },
          quizId: { $in: quizIdList }
        }).toArray()
      : [];

    const submissionsByQuizId = new Map();
    submissions.forEach((sub) => {
      const qId = sub.quizId ? sub.quizId.toString() : '';
      if (qId) {
        submissionsByQuizId.set(qId, sub);
      }
    });

    const subjectObjIds = subjectIdList.filter((id) => id instanceof ObjectId);
    const subjects = subjectObjIds.length
      ? await subjectsCollection.find({ _id: { $in: subjectObjIds } }).toArray()
      : [];
    const subjectsById = new Map(subjects.map((subject) => [subject._id.toString(), subject]));

    return res.json({
      quizzes: quizzes.map((quiz) => {
        const quizIdStr = quiz._id ? quiz._id.toString() : '';
        const sub = submissionsByQuizId.get(quizIdStr);
        return serializeQuiz({
          ...quiz,
          subjectCode: subjectsById.get(quiz.subjectId ? quiz.subjectId.toString() : '')?.code,
          submission: sub ? {
            score: sub.score,
            total: sub.total,
            percentage: sub.percentage,
            answers: sub.answers,
            submittedAt: sub.submittedAt
          } : null
        });
      })
    });
  } catch (error) {
    console.error('Error fetching student quizzes:', error);
    return res.status(500).json({ error: 'Failed to fetch quizzes.' });
  }
});

app.post('/api/student/quizzes/:quizId/submit', authenticateToken, requireStudent, async (req, res) => {
  try {
    const rawQuizId = req.params.quizId;
    if (!rawQuizId || !ObjectId.isValid(rawQuizId)) {
      return res.status(400).json({ error: 'Valid quiz is required.' });
    }
    const quizIdObj = new ObjectId(rawQuizId);
    const quizIdStr = rawQuizId.toString();
    const rawUserId = req.user.userId;
    const studentIdObj = ObjectId.isValid(rawUserId) ? new ObjectId(rawUserId) : null;
    const studentIdStr = rawUserId.toString();
    const studentIdFilters = studentIdObj ? [studentIdObj, studentIdStr] : [studentIdStr];

    const quiz = await quizzesCollection.findOne({
      $or: [{ _id: quizIdObj }, { _id: quizIdStr }]
    });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });

    const subjectIdFilters = [];
    if (quiz.subjectId) {
      if (ObjectId.isValid(quiz.subjectId)) subjectIdFilters.push(new ObjectId(quiz.subjectId));
      subjectIdFilters.push(quiz.subjectId.toString());
    }

    const enrollment = await enrollmentsCollection.findOne({
      studentId: { $in: studentIdFilters },
      subjectId: { $in: subjectIdFilters }
    });
    if (!enrollment) {
      return res.status(403).json({ error: 'You can only submit quizzes for enrolled subjects.' });
    }

    const existingSubmission = await quizSubmissionsCollection.findOne({
      studentId: { $in: studentIdFilters },
      quizId: { $in: [quizIdObj, quizIdStr] }
    });
    if (existingSubmission) {
      return res.status(400).json({
        error: 'You have already taken this quiz. Retakes are not permitted.',
        result: {
          score: existingSubmission.score,
          total: existingSubmission.total,
          percentage: existingSubmission.percentage,
          submittedAt: existingSubmission.submittedAt
        }
      });
    }

    const { answers } = req.body;
    if (!Array.isArray(answers) || answers.length !== quiz.questions.length) {
      return res.status(400).json({ error: 'Please answer every question before submitting.' });
    }
    const invalidAnswer = answers.some((answer) =>
      !Number.isInteger(answer) || answer < 0 || answer > 3
    );
    if (invalidAnswer) {
      return res.status(400).json({ error: 'Each answer must be a valid multiple-choice option.' });
    }

    const score = answers.reduce((total, answer, index) =>
      total + (answer === quiz.questions[index].correctOption ? 1 : 0), 0);
    const total = quiz.questions.length;
    const percentage = Math.round((score / total) * 100);
    const submission = {
      quizId: quizIdObj,
      studentId: studentIdObj || studentIdStr,
      answers,
      score,
      total,
      percentage,
      submittedAt: new Date()
    };
    await quizSubmissionsCollection.replaceOne(
      {
        quizId: quizIdObj,
        studentId: studentIdObj || studentIdStr
      },
      submission,
      { upsert: true }
    );
    return res.json({ result: { score, total, percentage, submittedAt: submission.submittedAt } });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    return res.status(500).json({ error: 'Failed to submit quiz.' });
  }
});

// Super admin user management
app.get('/api/admin/users', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const users = await usersCollection
      .find({}, { projection: { password: 0 } })
      .sort({ name: 1 })
      .toArray();

    return res.json({
      users: users.map((user) => ({
        id: user._id.toString(),
        ...getUserNameFields(user),
        name: user.name,
        email: user.email,
        role: user.role || 'student',
        createdAt: user.createdAt
      }))
    });
  } catch (error) {
    console.error('Error fetching users for admin:', error);
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

app.patch('/api/admin/users/:userId/role', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['student', 'faculty', 'program_chair', 'super_admin'];

    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Role must be student, faculty, program_chair, or super_admin.' });
    }

    if (!ObjectId.isValid(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid user ID.' });
    }

    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.userId) },
      { $set: { role, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { password: 0 } }
    );

    if (!result) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const profileCollection = role === 'student'
      ? studentsCollection
      : role === 'faculty'
        ? facultyCollection
        : role === 'program_chair'
          ? programChairsCollection
          : null;
    if (profileCollection) {
      await profileCollection.updateOne(
        { userId: result._id },
        { $setOnInsert: { userId: result._id, createdAt: new Date() }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
    }

    return res.json({
      message: 'User role updated successfully.',
      user: {
        id: result._id.toString(),
        name: result.name,
        email: result.email,
        role: result.role,
        createdAt: result.createdAt
      }
    });

  } catch (error) {
    console.error('Error updating user role:', error);
    return res.status(500).json({ error: 'Failed to update user role.' });
  }
});

app.patch('/api/admin/users/:userId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid user ID.' });
    }
    const firstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
    const middleName = typeof req.body.middleName === 'string' ? req.body.middleName.trim() : '';
    const lastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!firstName || !lastName || !isValidEmail(email)) {
      return res.status(400).json({ error: 'First name, last name, and a valid TUP email are required.' });
    }
    const userId = new ObjectId(req.params.userId);
    const result = await usersCollection.findOneAndUpdate(
      { _id: userId },
      {
        $set: {
          firstName,
          middleName,
          lastName,
          name: [firstName, middleName, lastName].filter(Boolean).join(' '),
          email,
          updatedAt: new Date()
        }
      },
      { returnDocument: 'after', projection: { password: 0 } }
    );
    if (!result) return res.status(404).json({ error: 'User not found.' });
    return res.json({
      message: 'User updated successfully.',
      user: {
        id: result._id.toString(),
        ...getUserNameFields(result),
        name: result.name,
        email: result.email,
        role: result.role || 'student',
        createdAt: result.createdAt
      }
    });
  } catch (error) {
    console.error('Error updating user:', error);
    return res.status(error.code === 11000 ? 409 : 500).json({
      error: error.code === 11000 ? 'That email address is already in use.' : 'Failed to update user.'
    });
  }
});

app.delete('/api/admin/users/:userId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID.' });
    if (req.params.userId === req.user.userId) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    const userId = new ObjectId(req.params.userId);
    const result = await usersCollection.deleteOne({ _id: userId });
    if (!result.deletedCount) return res.status(404).json({ error: 'User not found.' });
    await Promise.all([
      studentsCollection.deleteOne({ userId }),
      facultyCollection.deleteOne({ userId }),
      programChairsCollection.deleteOne({ userId }),
      enrollmentsCollection.deleteMany({ studentId: userId }),
      assignmentsCollection.deleteMany({ facultyId: userId }),
      chatMessagesCollection.deleteMany({ $or: [{ senderId: userId }, { recipientId: userId }] })
    ]);
    return res.json({ message: 'User deleted successfully.' });
  } catch (error) {
    console.error('Error deleting user:', error);
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
});

app.patch('/api/admin/students/:userId/placement', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { yearLevel, sectionId } = req.body;
    if (!yearLevel || typeof yearLevel !== 'string' || !ObjectId.isValid(sectionId)) {
      return res.status(400).json({ error: 'Year level and valid section are required.' });
    }
    const section = await sectionsCollection.findOne({ _id: new ObjectId(sectionId) });
    const student = await usersCollection.findOne({ _id: new ObjectId(req.params.userId), role: 'student' });
    if (!section || !student) return res.status(404).json({ error: 'Student or section not found.' });
    await studentsCollection.updateOne(
      { userId: student._id },
      { $set: { yearLevel: yearLevel.trim(), sectionId: new ObjectId(sectionId), updatedAt: new Date() } },
      { upsert: true }
    );
    return res.json({ message: 'Student placement updated successfully.' });
  } catch (error) {
    console.error('Error updating student placement:', error);
    return res.status(500).json({ error: 'Failed to update student placement.' });
  }
});

app.patch('/api/program-chair/students/:userId/placement', authenticateToken, requireProgramChair, async (req, res) => {
  try {
    const { yearLevel, term, sectionId } = req.body;
    if (!VALID_YEAR_LEVELS.includes(yearLevel) || !VALID_TERMS.includes(term) || !ObjectId.isValid(sectionId)) {
      return res.status(400).json({ error: 'Valid year level, term, and section are required.' });
    }
    const [section, student] = await Promise.all([
      sectionsCollection.findOne({ _id: new ObjectId(sectionId), yearLevel }),
      usersCollection.findOne({ _id: new ObjectId(req.params.userId), role: 'student' })
    ]);
    if (!section || !student) return res.status(404).json({ error: 'Student or matching section not found.' });
    await studentsCollection.updateOne(
      { userId: student._id },
      { $set: { yearLevel, term, sectionId: new ObjectId(sectionId), updatedAt: new Date() } },
      { upsert: true }
    );
    return res.json({ message: 'Student placement updated successfully.' });
  } catch (error) {
    console.error('Error updating program chair student placement:', error);
    return res.status(500).json({ error: 'Failed to update student placement.' });
  }
});

app.get('/api/admin/academic', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const [programs, sections, settings] = await Promise.all([
      programsCollection.find({}).sort({ name: 1 }).toArray(),
      sectionsCollection.find({}).sort({ name: 1 }).toArray(),
      academicSettingsCollection.findOne({ _id: 'current' })
    ]);
    return res.json({ programs, sections, settings: settings || null });
  } catch (error) {
    console.error('Error fetching academic structure:', error);
    return res.status(500).json({ error: 'Failed to fetch academic structure.' });
  }
});

app.patch('/api/admin/academic/settings', authenticateToken, requireSuperAdmin, async (req, res) => {
  const schoolYear = typeof req.body.schoolYear === 'string' ? req.body.schoolYear.trim() : '';
  const term = typeof req.body.term === 'string' ? req.body.term.trim() : '';
  if (!/^\d{4}-\d{4}$/.test(schoolYear) || !VALID_TERMS.includes(term)) {
    return res.status(400).json({ error: 'School year must use YYYY-YYYY format and term must be valid.' });
  }
  const [startYear, endYear] = schoolYear.split('-').map(Number);
  if (endYear !== startYear + 1) {
    return res.status(400).json({ error: 'School year must contain consecutive years.' });
  }
  try {
    const activeSubjects = await subjectsCollection
      .find({ term, schoolYear })
      .project({ _id: 1 })
      .toArray();
    const activeSubjectIds = activeSubjects.map((subject) => subject._id);
    const enrollmentCleanup = await enrollmentsCollection.deleteMany({
      $or: [
        { schoolYear: { $ne: schoolYear } },
        { subjectId: { $nin: activeSubjectIds } }
      ]
    });
    const settings = {
      _id: 'current',
      schoolYear,
      term,
      updatedAt: new Date(),
      updatedBy: req.user.userId
    };
    await academicSettingsCollection.replaceOne({ _id: 'current' }, settings, { upsert: true });
    return res.json({
      settings,
      removedEnrollments: enrollmentCleanup.deletedCount
    });
  } catch (error) {
    console.error('Error updating academic settings:', error);
    return res.status(500).json({ error: 'Failed to update academic settings.' });
  }
});

app.post('/api/admin/academic/programs', authenticateToken, requireSuperAdmin, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Program name is required.' });
  try {
    const result = await programsCollection.insertOne({ name, createdAt: new Date() });
    return res.status(201).json({ program: { id: result.insertedId.toString(), name } });
  } catch (error) {
    console.error('Error creating program:', error);
    return res.status(error.code === 11000 ? 409 : 500).json({ error: 'Failed to create program.' });
  }
});

app.patch('/api/admin/academic/programs/:programId', authenticateToken, requireSuperAdmin, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!ObjectId.isValid(req.params.programId) || !name) {
    return res.status(400).json({ error: 'A valid program and name are required.' });
  }
  try {
    const result = await programsCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.programId) },
      { $set: { name, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Program not found.' });
    await sectionsCollection.updateMany(
      { programId: result._id },
      { $set: { programName: name, updatedAt: new Date() } }
    );
    return res.json({ program: { id: result._id.toString(), name: result.name } });
  } catch (error) {
    console.error('Error updating program:', error);
    return res.status(error.code === 11000 ? 409 : 500).json({ error: error.code === 11000 ? 'A program with this name already exists.' : 'Failed to update program.' });
  }
});

app.delete('/api/admin/academic/programs/:programId', authenticateToken, requireSuperAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.programId)) {
    return res.status(400).json({ error: 'A valid program is required.' });
  }
  try {
    const programId = new ObjectId(req.params.programId);
    const sectionCount = await sectionsCollection.countDocuments({ programId });
    if (sectionCount) {
      return res.status(409).json({ error: 'Delete or move this program’s sections before deleting the program.' });
    }
    const result = await programsCollection.deleteOne({ _id: programId });
    if (!result.deletedCount) return res.status(404).json({ error: 'Program not found.' });
    return res.json({ message: 'Program deleted successfully.' });
  } catch (error) {
    console.error('Error deleting program:', error);
    return res.status(500).json({ error: 'Failed to delete program.' });
  }
});

app.post('/api/admin/academic/sections', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { name, yearLevel, programId, courseId } = req.body;
  const targetProgramId = programId || courseId;
  if (!name || !yearLevel || !targetProgramId || !ObjectId.isValid(targetProgramId)) {
    return res.status(400).json({ error: 'Section name, year level, and valid program are required.' });
  }
  let prog = await programsCollection.findOne({ _id: new ObjectId(targetProgramId) });
  if (!prog) {
    prog = await coursesCollection.findOne({ _id: new ObjectId(targetProgramId) });
  }
  if (!prog) return res.status(404).json({ error: 'Program not found.' });
  try {
    const result = await sectionsCollection.insertOne({
      name: name.trim(),
      yearLevel: yearLevel.trim(),
      programId: new ObjectId(targetProgramId),
      courseId: new ObjectId(targetProgramId),
      programName: prog.name,
      createdAt: new Date()
    });
    return res.status(201).json({
      section: {
        id: result.insertedId.toString(),
        name: name.trim(),
        yearLevel: yearLevel.trim(),
        programId: targetProgramId,
        programName: prog.name
      }
    });

  } catch (error) {
    console.error('Error creating section:', error);
    return res.status(error.code === 11000 ? 409 : 500).json({ error: 'Failed to create section.' });
  }
});

app.patch('/api/admin/academic/sections/:sectionId', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { name, yearLevel, programId, courseId } = req.body;
  const targetProgramId = programId || courseId;
  if (!ObjectId.isValid(req.params.sectionId) || !name?.trim() || !VALID_YEAR_LEVELS.includes(yearLevel) || !ObjectId.isValid(targetProgramId)) {
    return res.status(400).json({ error: 'Valid section name, year level, and program are required.' });
  }
  try {
    const program = await programsCollection.findOne({ _id: new ObjectId(targetProgramId) });
    if (!program) return res.status(404).json({ error: 'Program not found.' });
    const result = await sectionsCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.sectionId) },
      {
        $set: {
          name: name.trim(),
          yearLevel,
          programId: new ObjectId(targetProgramId),
          courseId: new ObjectId(targetProgramId),
          programName: program.name,
          updatedAt: new Date()
        }
      },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Section not found.' });
    return res.json({ section: { ...result, id: result._id.toString() } });
  } catch (error) {
    console.error('Error updating section:', error);
    return res.status(error.code === 11000 ? 409 : 500).json({ error: error.code === 11000 ? 'A section with these details already exists.' : 'Failed to update section.' });
  }
});

app.delete('/api/admin/academic/sections/:sectionId', authenticateToken, requireSuperAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.sectionId)) {
    return res.status(400).json({ error: 'A valid section is required.' });
  }
  try {
    const sectionId = new ObjectId(req.params.sectionId);
    const result = await sectionsCollection.deleteOne({ _id: sectionId });
    if (!result.deletedCount) return res.status(404).json({ error: 'Section not found.' });
    await Promise.all([
      studentsCollection.updateMany({ sectionId }, { $set: { sectionId: null, updatedAt: new Date() } }),
      assignmentsCollection.deleteMany({ sectionId })
    ]);
    return res.json({ message: 'Section deleted successfully.' });
  } catch (error) {
    console.error('Error deleting section:', error);
    return res.status(500).json({ error: 'Failed to delete section.' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// Start server
async function start() {
  await mongoClient.connect();
  database = mongoClient.db(databaseName);
  usersCollection = database.collection('users');
  subjectsCollection = database.collection('subjects');
  enrollmentsCollection = database.collection('enrollments');
  assignmentsCollection = database.collection('subjectAssignments');
  lessonsCollection = database.collection('lessons');
  lessonCompletionsCollection = database.collection('lessonCompletions');
  quizzesCollection = database.collection('quizzes');
  quizSubmissionsCollection = database.collection('quizSubmissions');
  chatMessagesCollection = database.collection('chatMessages');
  studentsCollection = database.collection('students');
  facultyCollection = database.collection('faculty');
  programChairsCollection = database.collection('programChairs');
  programsCollection = database.collection('programs');
  coursesCollection = database.collection('courses');
  sectionsCollection = database.collection('sections');
  academicSettingsCollection = database.collection('academicSettings');

  // Create unique index on email
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await subjectsCollection.createIndex({ code: 1, yearLevel: 1, term: 1 }, { unique: true });
  await enrollmentsCollection.createIndex({ studentId: 1, subjectId: 1 }, { unique: true });
  try {
    await assignmentsCollection.dropIndex('facultyId_1_subjectId_1');
  } catch (error) {
    if (error.codeName !== 'IndexNotFound' && error.codeName !== 'NamespaceNotFound') {
      throw error;
    }
  }
  await assignmentsCollection.createIndex({ facultyId: 1, subjectId: 1, sectionId: 1 }, { unique: true });
  await quizzesCollection.createIndex({ subjectId: 1, updatedAt: -1 });
  await quizSubmissionsCollection.createIndex({ quizId: 1, studentId: 1 }, { unique: true });
  await chatMessagesCollection.createIndex({ createdAt: -1 });
  await studentsCollection.createIndex({ userId: 1 }, { unique: true });
  await lessonCompletionsCollection.createIndex({ studentId: 1, lessonId: 1 }, { unique: true });
  await facultyCollection.createIndex({ userId: 1 }, { unique: true });
  await programChairsCollection.createIndex({ userId: 1 }, { unique: true });
  await programsCollection.createIndex({ name: 1 }, { unique: true });
  await coursesCollection.createIndex({ name: 1, programId: 1 }, { unique: true });
  await sectionsCollection.createIndex({ name: 1, courseId: 1, yearLevel: 1 }, { unique: true });
  const defaultSchoolYear = `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
  await academicSettingsCollection.updateOne(
    { _id: 'current' },
    { $setOnInsert: { _id: 'current', schoolYear: defaultSchoolYear, term: VALID_TERMS[0], updatedAt: new Date() } },
    { upsert: true }
  );
  const currentSettings = await academicSettingsCollection.findOne({ _id: 'current' });
  await subjectsCollection.updateMany(
    { schoolYear: { $exists: false } },
    { $set: { schoolYear: currentSettings.schoolYear, updatedAt: new Date() } }
  );
  await database.command({ ping: 1 });

  app.listen(port, '0.0.0.0', () => {
    console.log(`Backend server listening on port ${port} on all network interfaces`);
    console.log(`Connected to MongoDB database "${databaseName}"`);
    console.log(`Auth endpoints available:`);
    console.log(`  POST http://localhost:${port}/api/auth/register`);
    console.log(`  POST http://localhost:${port}/api/auth/login`);
    console.log(`  GET  http://localhost:${port}/api/auth/me`);
  });
}

start().catch((error) => {
  console.error('Unable to connect to MongoDB:', error);
  process.exitCode = 1;
});
