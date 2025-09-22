const express = require('express');
const twilio = require('twilio');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Twilio configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid || !authToken || !twilioPhoneNumber) {
    console.error('⚠️  Missing Twilio credentials in .env file');
    console.log('Please add:\nTWILIO_ACCOUNT_SID=your_sid\nTWILIO_AUTH_TOKEN=your_token\nTWILIO_PHONE_NUMBER=+1234567890');
}

const client = twilio(accountSid, authToken);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Initialize SQLite database
const db = new sqlite3.Database('events.db');

// Create tables
db.serialize(() => {
    // Events table
    db.run(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        datetime TEXT NOT NULL,
        location TEXT NOT NULL,
        max_participants INTEGER NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Invitations table
    db.run(`CREATE TABLE IF NOT EXISTS invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        responded_at DATETIME,
        FOREIGN KEY (event_id) REFERENCES events (id)
    )`);
});

// API Routes

// Create event and send SMS invitations
app.post('/api/events', async (req, res) => {
    const { name, datetime, location, maxParticipants, description, friends } = req.body;

    if (!name || !datetime || !location || !friends || friends.length === 0) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // Insert event into database
        const eventId = await new Promise((resolve, reject) => {
            const stmt = db.prepare(`INSERT INTO events (name, datetime, location, max_participants, description) 
                                   VALUES (?, ?, ?, ?, ?)`);
            
            stmt.run([name, datetime, location, maxParticipants, description], function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            });
            stmt.finalize();
        });

        // Insert invitations
        const invitePromises = friends.map(friend => {
            return new Promise((resolve, reject) => {
                const stmt = db.prepare(`INSERT INTO invitations (event_id, name, phone) VALUES (?, ?, ?)`);
                stmt.run([eventId, friend.name, friend.phone], function(err) {
                    if (err) reject(err);
                    else resolve();
                });
                stmt.finalize();
            });
        });

        await Promise.all(invitePromises);

        // Format date for SMS
        const eventDate = new Date(datetime);
        const formattedDate = eventDate.toLocaleDateString() + ' at ' + eventDate.toLocaleTimeString();

        // Create SMS message
        const smsMessage = `🎉 You're invited to ${name}!

📅 When: ${formattedDate}
📍 Where: ${location}
👥 Max ${maxParticipants} people

${description ? description + '\n\n' : ''}Reply YES to join or NO to decline. First ${maxParticipants} responses confirmed!

Event ID: ${eventId}`;

        // Send SMS to all friends
        const smsPromises = friends.map(friend => {
            return client.messages.create({
                body: smsMessage,
                from: twilioPhoneNumber,
                to: friend.phone
            });
        });

        const smsResults = await Promise.all(smsPromises);

        res.json({
            success: true,
            eventId: eventId,
            message: `Event created and SMS sent to ${friends.length} people`,
            smsResults: smsResults.map(result => result.sid)
        });

    } catch (error) {
        console.error('Error creating event:', error);
        res.status(500).json({ error: 'Failed to create event and send SMS' });
    }
});

// Webhook to handle incoming SMS responses
app.post('/webhook/sms', (req, res) => {
    const { From, Body } = req.body;
    const incomingMessage = Body.toLowerCase().trim();
    const phoneNumber = From;

    console.log(`📱 SMS from ${phoneNumber}: ${Body}`);

    // Extract event ID if present
    const eventIdMatch = Body.match(/event id:\s*(\d+)/i);
    
    if (!eventIdMatch && !incomingMessage.includes('yes') && !incomingMessage.includes('no')) {
        // Send help message
        client.messages.create({
            body: 'Please reply with YES or NO to respond to an event invitation, or include the Event ID in your message.',
            from: twilioPhoneNumber,
            to: phoneNumber
        });
        return res.status(200).send('');
    }

    // Find the invitation
    const findInvitation = (eventId) => {
        return new Promise((resolve, reject) => {
            let query, params;
            
            if (eventId) {
                query = `SELECT i.*, e.name as event_name, e.max_participants, e.datetime, e.location 
                        FROM invitations i 
                        JOIN events e ON i.event_id = e.id 
                        WHERE i.phone = ? AND i.event_id = ? AND i.status = 'pending'`;
                params = [phoneNumber, eventId];
            } else {
                query = `SELECT i.*, e.name as event_name, e.max_participants, e.datetime, e.location 
                        FROM invitations i 
                        JOIN events e ON i.event_id = e.id 
                        WHERE i.phone = ? AND i.status = 'pending' 
                        ORDER BY i.id DESC LIMIT 1`;
                params = [phoneNumber];
            }
            
            db.get(query, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    };

    const eventId = eventIdMatch ? parseInt(eventIdMatch[1]) : null;
    
    findInvitation(eventId)
        .then(invitation => {
            if (!invitation) {
                return client.messages.create({
                    body: 'No pending invitation found for this number. Please check the Event ID or contact the event organizer.',
                    from: twilioPhoneNumber,
                    to: phoneNumber
                });
            }

            let response = '';
            let newStatus = '';

            if (incomingMessage.includes('yes')) {
                // Check if event is full
                return new Promise((resolve, reject) => {
                    db.get(`SELECT COUNT(*) as confirmed_count 
                           FROM invitations 
                           WHERE event_id = ? AND status = 'confirmed'`,
                          [invitation.event_id], (err, result) => {
                        if (err) reject(err);
                        else resolve(result.confirmed_count);
                    });
                }).then(confirmedCount => {
                    if (confirmedCount >= invitation.max_participants) {
                        // Event is full - add to waitlist
                        newStatus = 'waitlist';
                        response = `Thanks ${invitation.name}! Unfortunately "${invitation.event_name}" is now full (${invitation.max_participants} people confirmed). You've been added to the waitlist and we'll notify you if a spot opens up! 🎉`;
                    } else {
                        // Confirm attendance
                        newStatus = 'confirmed';
                        const eventDate = new Date(invitation.datetime);
                        const formattedDate = eventDate.toLocaleDateString() + ' at ' + eventDate.toLocaleTimeString();
                        
                        response = `🎉 Awesome ${invitation.name}! You're CONFIRMED for "${invitation.event_name}"!

📅 ${formattedDate}
📍 ${invitation.location}

See you there! 🥳`;
                    }

                    // Update invitation status
                    return new Promise((resolve, reject) => {
                        db.run(`UPDATE invitations 
                               SET status = ?, responded_at = CURRENT_TIMESTAMP 
                               WHERE id = ?`,
                              [newStatus, invitation.id], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                });

            } else if (incomingMessage.includes('no')) {
                newStatus = 'declined';
                response = `Thanks for letting us know, ${invitation.name}. Maybe next time! 😊`;

                // Update invitation status
                return new Promise((resolve, reject) => {
                    db.run(`UPDATE invitations 
                           SET status = ?, responded_at = CURRENT_TIMESTAMP 
                           WHERE id = ?`,
                          [newStatus, invitation.id], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }
        })
        .then(() => {
            if (response) {
                return client.messages.create({
                    body: response,
                    from: twilioPhoneNumber,
                    to: phoneNumber
                });
            }
        })
        .catch(error => {
            console.error('Error processing SMS response:', error);
            client.messages.create({
                body: 'Sorry, there was an error processing your response. Please try again or contact support.',
                from: twilioPhoneNumber,
                to: phoneNumber
            });
        });

    res.status(200).send('');
});

// Get event details and responses
app.get('/api/events/:id', (req, res) => {
    const eventId = req.params.id;

    db.get(`SELECT * FROM events WHERE id = ?`, [eventId], (err, event) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        db.all(`SELECT * FROM invitations WHERE event_id = ? ORDER BY responded_at DESC`,
               [eventId], (err, invitations) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            // Group responses
            const responses = {
                confirmed: invitations.filter(i => i.status === 'confirmed'),
                declined: invitations.filter(i => i.status === 'declined'),
                waitlist: invitations.filter(i => i.status === 'waitlist'),
                pending: invitations.filter(i => i.status === 'pending')
            };

            res.json({
                event,
                responses,
                stats: {
                    total_invited: invitations.length,
                    confirmed: responses.confirmed.length,
                    declined: responses.declined.length,
                    waitlist: responses.waitlist.length,
                    pending: responses.pending.length
                }
            });
        });
    });
});

// Get all events
app.get('/api/events', (req, res) => {
    db.all(`SELECT e.*, COUNT(i.id) as total_invites,
                   SUM(CASE WHEN i.status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_count
            FROM events e 
            LEFT JOIN invitations i ON e.id = i.event_id 
            GROUP BY e.id 
            ORDER BY e.created_at DESC`, (err, events) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(events);
    });
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
    console.log(`🚀 Event Circles server running on port ${port}`);
    console.log(`📱 SMS webhook URL: http://your-domain.com/webhook/sms`);
    console.log(`💻 Web interface: http://localhost:${port}`);
    
    if (!accountSid) {
        console.log('\n⚠️  Don\'t forget to create a .env file with your Twilio credentials!');
    }
});
