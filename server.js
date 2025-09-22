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
app.use(express.static('public'));

// In-memory storage
let events = [];
let phoneNumbers = {};

// API Routes
app.get('/api/events', (req, res) => {
    res.json(events);
});

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
    sendInvitationsToAll(event);
    res.json(event);
});

app.post('/api/friends', (req, res) => {
    const { name, phoneNumber } = req.body;
    phoneNumbers[name] = phoneNumber;
    res.json({ success: true });
});

app.get('/api/friends', (req, res) => {
    res.json(phoneNumbers);
});

app.post('/api/sms-webhook', (req, res) => {
    const { From, Body } = req.body;
    const response = Body.trim().toUpperCase();
    
    const friendName = findFriendByPhone(From);
    if (!friendName) {
        console.log(`Unknown phone number: ${From}`);
        return res.status(200).send();
    }
    
    const activeEvents = events.filter(event => 
        event.status === 'active' && 
        event.pendingInvitations.includes(friendName)
    );
    
    activeEvents.forEach(event => {
        if (response === 'Y' || response === 'YES') {
            handleAcceptance(event, friendName, From);
        } else if (response === 'N' || response === 'NO') {
            handleDecline(event, friendName, From);
        }
    });
    
    res.status(200).send();
});

function sendInvitationsToAll(event) {
    Object.entries(phoneNumbers).forEach(([name, phone]) => {
        if (!event.invitationsSent.includes(name)) {
            const message = createInvitationMessage(event);
            
            client.messages.create({
                body: message,
                from: twilioPhoneNumber,
                to: phone
            }).then(() => {
                event.invitationsSent.push(name);
                event.pendingInvitations.push(name);
                console.log(`Invitation sent to ${name}`);
            }).catch(error => {
                console.error(`Failed to send SMS to ${name}:`, error);
            });
        }
    });
}

function createInvitationMessage(event) {
    const eventDate = new Date(event.dateTime);
    const dateStr = eventDate.toLocaleDateString('en-US', {
        weekday: 'short', 
        month: 'short', 
        day: 'numeric'
    });
    const timeStr = eventDate.toLocaleTimeString([], {
        hour: '2-digit', 
        minute: '2-digit'
    });
    
    const spotsLeft = event.maxParticipants - event.participants.length;
    
    let message = `🏌️ ${event.name}\n${dateStr} ${timeStr}\n📍 ${event.location}\n👥 ${spotsLeft} spots left`;
    
    if (event.participants.length > 0) {
        message += `\n✅ Going: ${event.participants.join(', ')}`;
    }
    
    message += `\n\nReply Y to join or N to pass`;
    return message;
}

function handleAcceptance(event, friendName, phoneNumber) {
    const pendingIndex = event.pendingInvitations.indexOf(friendName);
    if (pendingIndex > -1) {
        event.pendingInvitations.splice(pendingIndex, 1);
    }
    
    if (event.participants.length < event.maxParticipants) {
        event.participants.push(friendName);
        
        const confirmMessage = `Great! You're in for ${event.name}. See you there! 🎉`;
        client.messages.create({
            body: confirmMessage,
            from: twilioPhoneNumber,
            to: phoneNumber
        });
        
        if (event.participants.length >= event.maxParticipants) {
            event.status = 'full';
            sendEventFullMessages(event);
        }
    }
}

function handleDecline(event, friendName, phoneNumber) {
    const pendingIndex = event.pendingInvitations.indexOf(friendName);
    if (pendingIndex > -1) {
        event.pendingInvitations.splice(pendingIndex, 1);
    }
    
    const declineMessage = `No worries! Maybe next time. 👍`;
    client.messages.create({
        body: declineMessage,
        from: twilioPhoneNumber,
        to: phoneNumber
    });
}

function sendEventFullMessages(event) {
    event.pendingInvitations.forEach(friendName => {
        const phoneNumber = phoneNumbers[friendName];
        if (phoneNumber) {
            const fullMessage = `🚫 Sorry! ${event.name} is now full. Maybe next time! 😊`;
            client.messages.create({
                body: fullMessage,
                from: twilioPhoneNumber,
                to: phoneNumber
            });
        }
    });
    event.pendingInvitations = [];
}

function findFriendByPhone(phoneNumber) {
    for (const [name, phone] of Object.entries(phoneNumbers)) {
        if (phone === phoneNumber) {
            return name;
        }
    }
    return null;
}

app.listen(PORT, () => {
    console.log(`🚀 SMS Server running on port ${PORT}`);
});

module.exports = app;
