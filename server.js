// server.js - Node.js backend for SMS integration
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const client = twilio(accountSid, authToken);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve your HTML app

// In-memory storage (use a database in production)
let events = [];
let friendCircles = [];
let phoneNumbers = {}; // Map friend names to phone numbers

// API Routes

// Get all events
app.get('/api/events', (req, res) => {
    res.json(events);
});

// Create new event
app.post('/api/events', (req, res) => {
    const event = {
        id: Date.now(),
        ...req.body,
        participants: [],
        invitationsSent: [],
        pendingInvitations: [],
        responses: [],
        status: 'active'
    };
    
    events.push(event);
    
    // Send initial invitations
    sendInvitationsToCircle(event);
    
    res.json(event);
});

// Send SMS invitation
app.post('/api/send-sms', async (req, res) => {
    const { phoneNumber, message, friendName, eventId } = req.body;
    
    try {
        const smsMessage = await client.messages.create({
            body: message,
            from: twilioPhoneNumber,
            to: phoneNumber
        });
        
        console.log(`SMS sent to ${friendName} (${phoneNumber}): ${smsMessage.sid}`);
        res.json({ success: true, sid: smsMessage.sid });
    } catch (error) {
        console.error('SMS Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Handle SMS responses (webhook)
app.post('/api/sms-webhook', (req, res) => {
    const { From, Body } = req.body;
    const response = Body.trim().toUpperCase();
    
    // Find which friend this phone number belongs to
    const friendName = findFriendByPhone(From);
    if (!friendName) {
        console.log(`Unknown phone number: ${From}`);
        return res.status(200).send();
    }
    
    // Find active events this friend was invited to
    const activeEvents = events.filter(event => 
        event.status === 'active' && 
        event.pendingInvitations.includes(friendName)
);
