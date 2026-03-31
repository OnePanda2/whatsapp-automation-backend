// ============================================================
// services/ai.js — AI Message Generation (Google Gemini)
// ============================================================
// WHAT THIS DOES:
//   Generates unique, human-sounding follow-up messages using
//   Google Gemini. Each message is contextual to the contact
//   name and previous conversation context to avoid spam.
//
// WHERE TO PLACE: backend/services/ai.js
// ============================================================

const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use Gemini 2.0 Flash (fast, capable, and cost-effective)
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

/**
 * Generate a follow-up message for a WhatsApp contact.
 *
 * @param {Object} params
 * @param {string} params.contactName — Name of the contact
 * @param {string} params.lastMessageSent — The last message we sent them
 * @param {number} params.hoursSinceLastMessage — Hours since last message
 * @param {number} params.followUpCount — How many follow-ups already sent (0 = first)
 * @param {string} params.businessType — Type of business (e.g., "coaching", "agency")
 * @returns {Promise<string>} — The generated follow-up message
 */
async function generateFollowUp({
  contactName,
  lastMessageSent = '',
  hoursSinceLastMessage = 24,
  followUpCount = 0,
  businessType = 'service business',
}) {
  const urgencyLevel =
    followUpCount === 0
      ? 'gentle and friendly'
      : followUpCount === 1
        ? 'warm but slightly more direct'
        : 'polite but with a clear call-to-action';

  const prompt = `You are a WhatsApp follow-up assistant for a ${businessType}.

CONTEXT:
- Contact name: ${contactName}
- Last message you sent them: "${lastMessageSent || 'N/A'}"
- Hours since last message: ${hoursSinceLastMessage}
- This is follow-up attempt #${followUpCount + 1}

RULES:
1. Write a SHORT, conversational WhatsApp message (1-3 sentences max).
2. Tone: ${urgencyLevel}.
3. Do NOT start with "Hi", "Hey", or "Hello" every time — vary your openings.
4. Do NOT repeat the same message structure as the last message sent.
5. Sound like a real human texting, NOT a bot.
6. Include the contact's first name naturally if it fits.
7. Do NOT use emojis excessively (0-1 emoji max).
8. Do NOT mention "follow-up" or "checking in" — be creative.
9. End with an open-ended question when possible to invite a reply.

Write ONLY the message text. No quotes, no explanation, no preamble.`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const message = response.text()?.trim();

    if (!message) {
      throw new Error('AI returned empty message');
    }

    return message;
  } catch (error) {
    console.error('❌ AI generation failed:', error.message);
    // Fallback: return a safe generic message
    return `Hey ${contactName}, just wanted to circle back — would love to hear your thoughts when you get a chance!`;
  }
}

/**
 * Determine optimal follow-up timing using AI reasoning.
 *
 * @param {Object} params
 * @param {number} params.hoursSinceLastMessage
 * @param {number} params.followUpCount
 * @param {string} params.dayOfWeek — e.g., "Monday"
 * @param {number} params.hourOfDay — 0-23
 * @returns {Promise<number>} — Recommended delay in minutes before sending
 */
async function getOptimalDelay({
  hoursSinceLastMessage,
  followUpCount,
  dayOfWeek,
  hourOfDay,
}) {
  try {
    const result = await model.generateContent(
      `You are a messaging timing optimizer.

Given:
- Hours since last message: ${hoursSinceLastMessage}
- Follow-up attempt number: ${followUpCount + 1}
- Current day: ${dayOfWeek}
- Current hour (24h): ${hourOfDay}

Return ONLY a single integer: the number of MINUTES to wait before sending the next follow-up.

Guidelines:
- Business hours (9 AM - 7 PM) are best.
- Weekends = longer delay.
- More follow-ups = longer gaps between attempts.
- Minimum 30 minutes, maximum 4320 minutes (3 days).
- Don't cluster messages at predictable intervals.

Reply with ONLY the number, nothing else.`
    );

    const delayStr = result.response.text()?.trim();
    const delay = parseInt(delayStr, 10);

    if (isNaN(delay) || delay < 30) return 60; // minimum 1 hour
    if (delay > 4320) return 4320; // max 3 days

    return delay;
  } catch (error) {
    console.error('❌ AI timing failed, using fallback:', error.message);
    // Fallback: exponential backoff
    const base = 60; // 1 hour base
    return Math.min(base * Math.pow(2, followUpCount), 4320);
  }
}

/**
 * Use AI to evaluate if a follow-up is actually necessary.
 * 
 * @param {Object} params
 * @param {string} params.lastMessageSent — the actual text of the last message
 * @returns {Promise<boolean>} — True if follow-up is needed, False if resolved
 */
async function shouldFollowUp({ lastMessageSent }) {
  if (!lastMessageSent || lastMessageSent.trim() === '') return true; // Default to true if no text

  const prompt = `You are an AI follow-up assistant evaluating a single final message sent by a user.
  Message sent: "${lastMessageSent}"
  
  Does this message indicate the conversation has naturally concluded (meaning NO follow-up is needed)?
  
  Examples of CONCLUDED (Answer YES):
  - "Got it, thanks so much" or "Thank you"
  - "Sounds good" or "Okay"
  - "[Sticker]" or a lone emoji like "👍" or "🙏"
  - A simple URL/link sent without a question attached
  
  Examples of NOT CONCLUDED (Answer NO):
  - "Let me know what you think"
  - "Did you get a chance to review this?"
  - "When are you free?"
  
  Answer ONLY with "YES" (concluded, no follow-up needed) or "NO" (not concluded, follow-up needed).`;

  try {
    const result = await model.generateContent(prompt);
    const answer = result.response.text()?.trim().toUpperCase();
    
    // If the AI says YES (it has concluded), we do NOT want to follow up.
    if (answer.includes('YES')) {
      return false; // False = Do not follow up
    }
    return true; // True = Yes, send a follow-up
  } catch (error) {
    console.error('❌ AI validation failed, defaulting to follow-up:', error.message);
    return true;
  }
}

/**
 * Use AI to read the last few messages and evaluate if a follow-up is necessary.
 * 
 * @param {Object} params
 * @param {string} params.contactName
 * @param {Array} params.chatHistory — [{ sender: 'me'|'them', text: '...', time: '...' }]
 * @returns {Promise<boolean>} — True if follow-up is needed
 */
async function validateChatContext({ contactName, chatHistory }) {
  if (!chatHistory || chatHistory.length === 0) return true;

  const historyText = chatHistory
    .map(m => `[${m.sender === 'me' ? 'You' : contactName}]: ${m.text}`)
    .join('\n');

  const prompt = `You are an AI follow-up assistant.
  Read the end of this conversation between You and ${contactName}:
  
  ${historyText}
  
  Does the context of this conversation indicate that it has naturally concluded, or that a follow-up is NOT needed?
  Pay special attention to emojis, stickers, or GIFs (e.g., "[Sticker]", "👍"). Just because the last message is an emoji does NOT automatically mean the conversation is over. Look at the flow.
  
  Answer ONLY with "YES" (it has concluded/no follow-up needed) or "NO" (it has not concluded/follow-up IS needed).`;

  try {
    const result = await model.generateContent(prompt);
    const answer = result.response.text()?.trim().toUpperCase();
    
    if (answer.includes('YES')) {
      return false; // False = Do not follow up
    }
    return true; // True = Yes, send a follow-up
  } catch (error) {
    console.error('❌ AI context validation failed:', error.message);
    return true;
  }
}

module.exports = { generateFollowUp, getOptimalDelay, shouldFollowUp, validateChatContext };
