const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const twilio = require('twilio');
const { GoogleGenAI, Type } = require('@google/genai');
const { Session, TTSRequest } = require('fish-audio-sdk');
const fs = require('fs');
const path = require('path');
const mime = require('mime');
require('dotenv').config();

// μ-law to PCM conversion table
const mulawToPcm = new Array(256);
for (let i = 0; i < 256; i++) {
  const mulaw = i ^ 0x55;
  const exponent = (mulaw & 0x70) >> 4;
  const mantissa = mulaw & 0x0F;
  let sample = mantissa * 2 + 33;
  sample <<= exponent + 2;
  if (mulaw & 0x80) sample = -sample;
  mulawToPcm[i] = sample;
}

// Convert μ-law audio to PCM
function convertMulawToPcm(mulawData) {
  const buffer = Buffer.from(mulawData, 'base64');
  const pcmBuffer = Buffer.alloc(buffer.length * 2); // 16-bit PCM
  
  for (let i = 0; i < buffer.length; i++) {
    const pcmValue = mulawToPcm[buffer[i]];
    pcmBuffer.writeInt16LE(pcmValue, i * 2);
  }
  
  return pcmBuffer.toString('base64');
}

// WAV conversion utilities for Fish Audio TTS
function parseMimeType(mimeType) {
  const [fileType, ...params] = mimeType.split(';').map(s => s.trim());
  const [_, format] = fileType.split('/');

  const options = {
    numChannels: 1,
    sampleRate: 8000,
    bitsPerSample: 16
  };

  if (format && format.startsWith('L')) {
    const bits = parseInt(format.slice(1), 10);
    if (!isNaN(bits)) {
      options.bitsPerSample = bits;
    }
  }

  for (const param of params) {
    const [key, value] = param.split('=').map(s => s.trim());
    if (key === 'rate') {
      options.sampleRate = parseInt(value, 10);
    }
  }

  return options;
}

function createWavHeader(dataLength, options) {
  const {
    numChannels,
    sampleRate,
    bitsPerSample,
  } = options;

  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0);                      // ChunkID
  buffer.writeUInt32LE(36 + dataLength, 4);     // ChunkSize
  buffer.write('WAVE', 8);                      // Format
  buffer.write('fmt ', 12);                     // Subchunk1ID
  buffer.writeUInt32LE(16, 16);                 // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20);                  // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22);        // NumChannels
  buffer.writeUInt32LE(sampleRate, 24);         // SampleRate
  buffer.writeUInt32LE(byteRate, 28);           // ByteRate
  buffer.writeUInt16LE(blockAlign, 32);         // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34);      // BitsPerSample
  buffer.write('data', 36);                     // Subchunk2ID
  buffer.writeUInt32LE(dataLength, 40);         // Subchunk2Size

  return buffer;
}

function convertToWav(rawData, mimeType) {
  const options = parseMimeType(mimeType);
  const wavHeader = createWavHeader(rawData.length, options);
  const buffer = Buffer.from(rawData, 'base64');
  
  return Buffer.concat([wavHeader, buffer]);
}

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Global variables for managing call sessions
const callSessions = new Map();
const callStates = new Map(); // Track conversation state for each call
const conversationHistory = new Map(); // Track conversation context

// Load system prompt
const systemPrompt = fs.readFileSync(path.join(__dirname, 'prompt.txt'), 'utf8');

// Initialize Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Initialize Google Gemini client
const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Initialize Fish Audio session
const fishAudioSession = new Session(process.env.FISH_AUDIO_API_KEY);

// Function to send SMS
async function sendSMS(to, message) {
  try {
    const sms = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to
    });
    console.log(`✅ SMS sent to ${to}: ${sms.sid}`);
    return sms;
  } catch (error) {
    console.error('❌ SMS Error:', error);
    throw error;
  }
}

// Function to handle tool calls
async function handleToolCall(functionCall, callSid) {
  // Handle both old and new function call formats
  const name = functionCall.name;
  const args = functionCall.args || functionCall.arguments || {};
  
  console.log(`🔧 Handling function call: ${name} with args:`, args);
  
  switch (name) {
    case 'SMSInfo':
      const { name: callerName, summary } = args;
      const timestamp = new Date().toLocaleTimeString();
      
      // Get caller's phone number from call state
      const callState = callStates.get(callSid) || {};
      const callerNumber = callState.from || 'Unknown';
      
      // Check if this was detected as spam
      const isSpam = summary.toLowerCase().includes('spam') || 
                    summary.toLowerCase().includes('robotic') || 
                    summary.toLowerCase().includes('automated') ||
                    callerName === 'Unknown Caller';
      
      let message;
      if (isSpam) {
        message = `🚨 SPAM ALERT (${timestamp})\n\nFrom: ${callerNumber}\nCaller: ${callerName}\nDetails: ${summary}\nCall ID: ${callSid.substring(0, 8)}...\n\n⚠️ This call was automatically screened as likely spam.\nReply 'BLOCK' to block this number permanently.`;
      } else {
        message = `🔔 Call Screening Alert (${timestamp})\n\nFrom: ${callerNumber}\nCaller: ${callerName}\nReason: ${summary}\nCall ID: ${callSid.substring(0, 8)}...\n\nReply 'ACCEPT' to connect, 'DENY' to decline, or 'BLOCK' to block this number.`;
      }
      
      try {
        await sendSMS(process.env.RECIPIENT_PHONE_NUMBER, message);
        // Update call state
        const state = callStates.get(callSid) || {};
        state.smsSent = true;
        state.callerName = callerName;
        state.summary = summary;
        state.isSpam = isSpam;
        callStates.set(callSid, state);
        
        console.log(`📱 SMS sent successfully for call ${callSid} (spam: ${isSpam})`);
        return { response: 'SMS sent successfully' };
      } catch (error) {
        console.error(`❌ SMS failed for call ${callSid}:`, error);
        return { response: 'Failed to send SMS: ' + error.message };
      }
      
    case 'OnHold':
      console.log(`🔒 Call ${callSid} placed on hold`);
      
      // Update call state
      const state = callStates.get(callSid) || {};
      state.onHold = true;
      callStates.set(callSid, state);
      
      // Actually put the call on hold with TwiML using pre-recorded audio
      try {
        const twiml = new twilio.twiml.VoiceResponse();
        
        // Play pre-recorded hold message
        const holdMessageUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/hold.mp3`;
        twiml.play(holdMessageUrl);
        
        // Play hold music after the message
        const holdMusicUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/hold-music`;
        twiml.play({
          loop: 999
        }, holdMusicUrl);
        
        // Update the call with hold TwiML
        await twilioClient.calls(callSid).update({
          twiml: twiml.toString()
        });
        
        console.log(`🎵 Hold message and music started for call ${callSid} using pre-recorded audio`);
        return { response: 'Call placed on hold with pre-recorded message' };
      } catch (error) {
        console.error(`❌ Hold failed for call ${callSid}:`, error);
        return { response: 'Failed to put call on hold: ' + error.message };
      }
      
    case 'Hangup':
      console.log(`📞 Hanging up call ${callSid}`);
      try {
        // Get caller's info for SMS notification
        const callState = callStates.get(callSid) || {};
        const callerNumber = callState.from || 'Unknown';
        
        // Automatically send SMS notification for spam calls
        const timestamp = new Date().toLocaleTimeString();
        const spamMessage = `🚨 SPAM ALERT (${timestamp})\n\nFrom: ${callerNumber}\nCaller: Unknown Caller\nDetails: Call automatically screened as spam and terminated\nCall ID: ${callSid.substring(0, 8)}...\n\n⚠️ This call was automatically hung up due to spam detection.\nReply 'BLOCK' to block this number permanently.`;
        
        try {
          await sendSMS(process.env.RECIPIENT_PHONE_NUMBER, spamMessage);
          console.log(`📱 Spam notification SMS sent automatically for call ${callSid}`);
        } catch (smsError) {
          console.error(`❌ Failed to send spam notification SMS for call ${callSid}:`, smsError);
        }
        
        // Play deny message before hanging up
        const twiml = new twilio.twiml.VoiceResponse();
        const denyMessageUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
        twiml.play(denyMessageUrl);
        twiml.hangup();
        
        // Update the call with hangup TwiML
        await twilioClient.calls(callSid).update({
          twiml: twiml.toString()
        });
        
        // Clean up all data for this call
        callSessions.delete(callSid);
        callStates.delete(callSid);
        conversationHistory.delete(callSid);
        
        console.log(`🎵 Deny message played and call terminated for ${callSid}`);
        return { response: 'Call terminated with pre-recorded message and SMS sent' };
      } catch (error) {
        return { response: 'Failed to hang up: ' + error.message };
      }
      
    case 'Forward':
      console.log(`🔄 Forwarding call ${callSid}`);
      return { response: 'Call forwarded' };
      
    default:
      console.log(`❓ Unknown function: ${name}`);
      return { response: 'Unknown function' };
  }
}

// Add fallback text-based Gemini processing
async function processWithTextGemini(transcript, callSid) {
  try {
    console.log(`📝 Processing transcript with text Gemini for call ${callSid}: "${transcript}"`);
    
    // Get or create conversation history
    if (!conversationHistory.has(callSid)) {
      conversationHistory.set(callSid, []);
    }
    const history = conversationHistory.get(callSid);
    history.push(`Caller: ${transcript}`);
    
    const callState = callStates.get(callSid) || {};
    
    // Build context with conversation history
    let context = `You are screening an incoming call. Here's the conversation so far:\n`;
    context += history.join('\n');
    context += `\n\nAnalyze this conversation carefully. Look for:
1. The caller's NAME (any name they provide)
2. The REASON for their call (why they're calling)

If you can identify BOTH a name AND a reason from the conversation, immediately call OnHold() first, then SMSInfo() with the name and summary.

Examples of having both pieces:
- "My name is John, I'm calling about your car's extended warranty" → Name: John, Reason: car's extended warranty
- "This is Sarah calling regarding your student loan" → Name: Sarah, Reason: student loan
- "Hi, I'm Mike from ABC Company about your insurance" → Name: Mike, Reason: insurance

If you're missing either the name OR the reason, ask for the missing information clearly.`;

    const tools = [
      {
        functionDeclarations: [
          {
            name: 'SMSInfo',
            description: 'Sends the caller\'s name and summary of their reason for calling via SMS.',
            parameters: {
              type: Type.OBJECT,
              required: ["name", "summary"],
              properties: {
                name: {
                  type: Type.STRING,
                  description: "The name of the caller.",
                },
                summary: {
                  type: Type.STRING,
                  description: "A brief summary of the caller's reason for calling.",
                },
              },
            },
          },
          {
            name: 'OnHold',
            description: 'Places the current caller on hold.',
            parameters: {
              type: Type.OBJECT,
              properties: {},
            },
          },
        ]
      }
    ];

    const config = {
      tools,
      systemInstruction: systemPrompt
    };

    const contents = [
      {
        role: 'user',
        parts: [{ text: context }],
      },
    ];

    const result = await genAI.models.generateContent({
      model: "gemini-2.0-flash-exp",
      config,
      contents,
    });
    
    // Check for function calls in the response
    if (result.functionCalls && result.functionCalls.length > 0) {
      for (const functionCall of result.functionCalls) {
        console.log(`🔧 Text Gemini generated function call for call ${callSid}: ${functionCall.name}`);
        console.log(`🎯 Execute function ${functionCall.name} with arguments:`, functionCall.args);
        try {
          await handleToolCall(functionCall, callSid);
          console.log(`✅ Function ${functionCall.name} executed successfully for call ${callSid}`);
        } catch (error) {
          console.error(`❌ Error executing function ${functionCall.name}:`, error);
        }
      }
    }
    
    // Get text response
    if (result.text && result.text.trim()) {
      console.log(`💬 Text Gemini response for call ${callSid}: ${result.text}`);
      
      // Add AI response to history
      history.push(`AI: ${result.text}`);
      
      // Convert text to speech and play back
      await speakToTwilio(result.text, callSid);
    } else {
      console.log(`⚠️ No text response from Gemini for call ${callSid}`);
      
      // Send a default response
      await speakToTwilio("I'm processing your information. Please hold on.", callSid);
    }
    
    callState.conversationStarted = true;
    callStates.set(callSid, callState);
    
  } catch (error) {
    console.error(`❌ Error processing with text Gemini for call ${callSid}:`, error);
    
    // Fallback response
    await speakToTwilio("I'm sorry, I'm having trouble processing that. Could you please repeat your name and reason for calling?", callSid);
  }
}

// Synchronous version that returns TwiML instead of updating call
async function processWithTextGeminiSync(transcript, callSid) {
  try {
    console.log(`📝 Processing transcript with text Gemini for call ${callSid}: "${transcript}"`);
    
    // Get or create conversation history
    if (!conversationHistory.has(callSid)) {
      conversationHistory.set(callSid, []);
    }
    const history = conversationHistory.get(callSid);
    history.push(`Caller: ${transcript}`);
    
    const callState = callStates.get(callSid) || {};
    
    // Build context with conversation history
    let context = `You are an AI call screening assistant. A pre-recorded greeting has already been played. Analyze this conversation:\n`;
          context += history.join('\n');
      context += `\n\nINSTRUCTIONS:
1. EXTRACT INFORMATION INTELLIGENTLY from what the caller says
2. BE PATIENT - Give callers 2-3 chances to clarify before considering spam
3. SPAM DETECTION: Only call Hangup() for OBVIOUS SPAM like:
   - Clear robotic voices saying "car warranty", "insurance", "credit cards", "final notice"
   - Obviously scripted sales pitches about "saving money" or "limited time offers"
   - Calls that start with recorded messages or sound clearly robotic
   - Clear background call center noise with scripted responses
4. DO NOT HANG UP for: unclear speech, bad connection, nervous callers, accents, first-time confusion
5. If you have the REASON but no NAME: Ask "What is your name?" (vary your language)
6. If you have the NAME but no REASON: Ask "What is the reason for your call?" (vary your language)
7. If response is unclear/confusing: Ask for clarification patiently - give them multiple chances
8. Once you have BOTH pieces of information:
   - For LEGITIMATE calls: call OnHold() first, then SMSInfo(name, summary)
   - For OBVIOUS SPAM: call Hangup() ONLY (SMS is sent automatically)
9. DON'T repeat the same question - be smart and vary your responses
10. Be conversational, professional, and PATIENT - don't sound robotic yourself

IMPORTANT: NEVER call both Hangup() and SMSInfo() together - Hangup() handles SMS automatically.

RESPOND WITH ONLY YOUR NEXT MESSAGE TO THE CALLER - DO NOT REPEAT THE CONVERSATION HISTORY.
VARY YOUR LANGUAGE - use different words each time. Examples:
- "Could you tell me your name?" / "What's your name?" / "May I get your name?"
- "What's the reason for your call?" / "What are you calling about?" / "What can I help you with?"
- "I'm sorry, I didn't catch that. Could you repeat your name?"
- "Could you clarify what you're calling about?"

ESCALATION PATTERN:
1. First unclear response: Ask for clarification politely
2. Second unclear response: Ask more directly but remain patient  
3. Third unclear response: If still no clear name/reason, then consider spam

CURRENT STATUS: Analyze the conversation and determine:
- NAME: Do you have the caller's name? If not, can you help them clarify?
- REASON: Do you have the reason for calling? If not, can you help them explain?
- SPAM LEVEL: Is this OBVIOUS spam that should be hung up on immediately?
- PATIENCE: How many chances have you given them to clarify?
- ACTION: If obvious spam, call Hangup() ONLY. If you have both name/reason, call OnHold() then SMSInfo(). Otherwise ask for missing info with patience.`;

    console.log(`🧠 Context being sent to Gemini for call ${callSid}:`, context);

    const tools = [
      {
        functionDeclarations: [
          {
            name: 'SMSInfo',
            description: 'Sends the caller\'s name and summary of their reason for calling via SMS.',
            parameters: {
              type: Type.OBJECT,
              required: ["name", "summary"],
              properties: {
                name: {
                  type: Type.STRING,
                  description: "The name of the caller.",
                },
                summary: {
                  type: Type.STRING,
                  description: "A brief summary of the caller's reason for calling.",
                },
              },
            },
          },
          {
            name: 'OnHold',
            description: 'Places the current caller on hold.',
            parameters: {
              type: Type.OBJECT,
              properties: {},
            },
          },
          {
            name: 'Hangup',
            description: 'Terminates the current call and automatically sends SMS notification. Use ONLY for obvious spam calls.',
            parameters: {
              type: Type.OBJECT,
              properties: {},
            },
          },
        ]
      }
    ];

    const config = {
      tools,
      systemInstruction: systemPrompt
    };

    const contents = [
      {
        role: 'user',
        parts: [{ text: context }],
      },
    ];

    const result = await genAI.models.generateContent({
      model: "gemini-2.0-flash-exp",
      config,
      contents,
    });
    
    console.log(`🤖 Raw Gemini response for call ${callSid}:`, JSON.stringify(result, null, 2));
    
    // Check for function calls in the response
    let holdCalled = false;
    if (result.functionCalls && result.functionCalls.length > 0) {
      for (const functionCall of result.functionCalls) {
        console.log(`🔧 Text Gemini generated function call for call ${callSid}: ${functionCall.name}`);
        console.log(`🎯 Execute function ${functionCall.name} with arguments:`, functionCall.args);
        try {
          await handleToolCall(functionCall, callSid);
          console.log(`✅ Function ${functionCall.name} executed successfully for call ${callSid}`);
          
          // Track if OnHold was called
          if (functionCall.name === 'OnHold') {
            holdCalled = true;
          }
        } catch (error) {
          console.error(`❌ Error executing function ${functionCall.name}:`, error);
        }
      }
    }
    
    // If hold was called, don't continue the conversation - let the hold music play
    if (holdCalled) {
      console.log(`🔒 Call ${callSid} is on hold - no further processing needed`);
      return null; // Don't return any TwiML to avoid overriding hold music
    }
    
    // Generate TwiML response
    if (result.text && result.text.trim()) {
      console.log(`💬 Text Gemini response for call ${callSid}: ${result.text}`);
      
      // Extract only the new AI response (not the repeated conversation history)
      let aiResponse = result.text.trim();
      
      // If the response contains conversation history, extract only the new part
      const lines = aiResponse.split('\n');
      let newResponse = '';
      
      // Look for lines that don't start with "Caller:" or "AI:" - these are the new response
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line && !line.startsWith('Caller:') && !line.startsWith('AI:')) {
          if (newResponse) {
            newResponse = line + '\n' + newResponse;
          } else {
            newResponse = line;
          }
        } else if (newResponse) {
          // We found the new response, stop looking
          break;
        }
      }
      
      // If we couldn't extract a clean response, use the last non-empty line
      if (!newResponse) {
        newResponse = lines[lines.length - 1].trim();
      }
      
      console.log(`🎯 Extracted AI response for call ${callSid}: "${newResponse}"`);
      
      // Add AI response to history
      history.push(`AI: ${newResponse}`);
      
      // Generate TwiML with Fish Audio TTS or fallback to Twilio TTS
      const twiml = await generateTwiMLWithSpeech(newResponse, callSid);
      
      callState.conversationStarted = true;
      callStates.set(callSid, callState);
      
      return { twiml: twiml };
    } else {
      console.log(`⚠️ No text response from Gemini for call ${callSid}`);
      
      // Fallback TwiML
      const twiml = await generateTwiMLWithSpeech("I'm processing your information. Please hold on.", callSid);
      return { twiml: twiml };
    }
    
  } catch (error) {
    console.error(`❌ Error processing with text Gemini for call ${callSid}:`, error);
    
    // Fallback TwiML
    const twiml = await generateTwiMLWithSpeech("I'm sorry, I'm having trouble processing that. Could you please repeat your name and reason for calling?", callSid);
    return { twiml: twiml };
  }
}

// Generate TwiML with speech (Fish Audio TTS only - NO Twilio voice!)
async function generateTwiMLWithSpeech(text, callSid) {
  const twiml = new twilio.twiml.VoiceResponse();
  
  try {
    console.log(`🗣️ Generating speech for call ${callSid}: "${text}"`);
    
    // Generate Fish Audio TTS
    const audioBuffer = await generateFishAudioTTS(text);
    
    if (audioBuffer) {
      // Create temporary audio file
      const tempAudioPath = path.join(__dirname, 'temp', `audio_${callSid}_${Date.now()}.mp3`);
      
      // Ensure temp directory exists
      const tempDir = path.join(__dirname, 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Write audio to temp file
      fs.writeFileSync(tempAudioPath, audioBuffer);
      
      // Play the generated audio
      const playUrl = `https://twilio-call-screening.loca.lt/temp-audio/${path.basename(tempAudioPath)}`;
      
      // Continue listening for speech during and after the audio
      const gather = twiml.gather({
        input: 'speech',
        timeout: 15,
        speechTimeout: 3,
        action: `/voice-response/${callSid}`,
        method: 'POST',
        enhanced: true
      });
      
      // Play the Fish Audio TTS file as part of the gather prompt
      gather.play(playUrl);
      console.log(`🎵 Using Fish Audio TTS for call ${callSid} - URL: ${playUrl}`);
      
      // If gather times out, hang up - no fallback to Twilio voice
      const denyUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
      twiml.play(denyUrl);
      twiml.hangup();
      
      // Clean up temp file after a longer delay to ensure it's served
      setTimeout(() => {
        try {
          if (fs.existsSync(tempAudioPath)) {
            fs.unlinkSync(tempAudioPath);
            console.log(`🧹 Cleaned up temp audio file: ${path.basename(tempAudioPath)}`);
          }
        } catch (error) {
          console.error('Error cleaning up temp audio file:', error);
        }
      }, 120000); // Clean up after 2 minutes
    } else {
      // If Fish Audio TTS fails, hang up with deny message - NO Twilio voice fallback
      console.error(`❌ Fish Audio TTS failed for call ${callSid}, hanging up`);
      const denyUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
      twiml.play(denyUrl);
      twiml.hangup();
    }
    
    const twimlString = twiml.toString();
    console.log(`🎵 Generated TwiML for call ${callSid}:`, twimlString);
    return twimlString;
    
  } catch (error) {
    console.error(`❌ Error generating TwiML speech for call ${callSid}:`, error);
    
    // Error fallback - hang up with deny message, NO Twilio voice
    const denyUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
    twiml.play(denyUrl);
    twiml.hangup();
    
    const twimlString = twiml.toString();
    console.log(`🎵 Generated TwiML (error fallback) for call ${callSid}:`, twimlString);
    return twimlString;
  }
}

// Function to convert text to speech using Fish Audio TTS API
async function speakToTwilio(text, callSid) {
  const callState = callStates.get(callSid) || {};
  
  if (callState.onHold) {
    console.log(`📵 Skipping speech for call ${callSid} - on hold`);
    return;
  }
  
  try {
    console.log(`🗣️ Speaking to call ${callSid}: "${text}"`);
    
    // Generate audio using Fish Audio TTS API
    const audioBuffer = await generateFishAudioTTS(text);
    
    if (audioBuffer) {
      // Play the generated audio to the call
      await playAudioToTwilio(audioBuffer, callSid);
    } else {
      // Fallback to Twilio TTS if Fish Audio TTS fails
      await speakWithTwilioTTS(text, callSid);
    }
    
    console.log(`🗣️ Speech updated for call ${callSid}`);
    
  } catch (error) {
    console.error(`❌ Error speaking to call ${callSid}:`, error);
    // Fallback to Twilio TTS
    await speakWithTwilioTTS(text, callSid);
  }
}

// Generate audio using Fish Audio TTS API
async function generateFishAudioTTS(text) {
  try {
    if (!process.env.FISH_AUDIO_API_KEY) {
      console.error('❌ Fish Audio API key not configured');
      return null;
    }
    
    console.log(`🐟 Generating Fish Audio TTS for: "${text}"`);
    
    const request = new TTSRequest(text, {
      format: "mp3",
      mp3Bitrate: 128,
      sampleRate: 44100,  // Back to working sample rate
      chunkLength: 200,
      normalize: true,
      latency: "balanced",
      referenceId: "dc21b4b6e8f04dfb99b9212985bc3515",
    });

    const headers = { 
      model: 'speech-1.6'
    };

    const audioChunks = [];
    
    for await (const chunk of fishAudioSession.tts(request, headers)) {
      audioChunks.push(chunk);
    }
    
    if (audioChunks.length > 0) {
      console.log(`🐟 Fish Audio TTS generated ${audioChunks.length} chunks`);
      return Buffer.concat(audioChunks);
    }
    
    return null;
    
  } catch (error) {
    console.error('❌ Error generating Fish Audio TTS:', error);
    console.error('Error details:', error.message);
    return null;
  }
}

// Fallback function using Twilio TTS (used when Fish Audio TTS fails)
async function speakWithTwilioTTS(text, callSid) {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    
    // Speak the text
    twiml.say({
      voice: 'Polly.Joanna'
    }, text);
    
    // Continue listening for more input
    const gather = twiml.gather({
      input: 'speech',
      timeout: 10,
      speechTimeout: 2,
      action: `/voice-response/${callSid}`,
      method: 'POST'
    });
    
    // Fallback if no speech detected
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'I didn\'t hear anything. Could you please repeat that?');
    
    await twilioClient.calls(callSid).update({
      twiml: twiml.toString()
    });
    
    console.log(`🗣️ Fallback Twilio TTS used for call ${callSid}`);
    
  } catch (error) {
    console.error(`❌ Error with Twilio TTS for call ${callSid}:`, error);
  }
}

// Play audio buffer to Twilio call
async function playAudioToTwilio(audioBuffer, callSid) {
  try {
    // Create temporary audio file
    const tempAudioPath = path.join(__dirname, 'temp', `audio_${callSid}_${Date.now()}.mp3`);
    
    // Ensure temp directory exists
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Write audio to temp file
    fs.writeFileSync(tempAudioPath, audioBuffer);
    
    // Create TwiML with play instruction
    const twiml = new twilio.twiml.VoiceResponse();
    
    // Play the generated audio
    const playUrl = `https://twilio-call-screening.loca.lt/temp-audio/${path.basename(tempAudioPath)}`;
    twiml.play(playUrl);
    
    // Continue listening for more input
    const gather = twiml.gather({
      input: 'speech',
      timeout: 10,
      speechTimeout: 2,
      action: `/voice-response/${callSid}`,
      method: 'POST'
    });
    
    // Fallback if no speech detected
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'I didn\'t hear anything. Could you please repeat that?');
    
    await twilioClient.calls(callSid).update({
      twiml: twiml.toString()
    });
    
    // Clean up temp file after a delay
    setTimeout(() => {
      try {
        if (fs.existsSync(tempAudioPath)) {
          fs.unlinkSync(tempAudioPath);
        }
      } catch (error) {
        console.error('Error cleaning up temp audio file:', error);
      }
    }, 30000); // Clean up after 30 seconds
    
  } catch (error) {
    console.error(`❌ Error playing audio to call ${callSid}:`, error);
  }
}





// Twilio webhook endpoints
app.post('/voice', async (req, res) => {
  const { CallSid, From, To } = req.body;
  console.log(`Incoming call from ${From} to ${To}, CallSid: ${CallSid}`);

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    // Initialize call state with caller's phone number
    callStates.set(CallSid, {
      connected: true,
      smsSent: false,
      onHold: false,
      conversationStarted: false,
      from: From // Store caller's phone number
    });
    
    console.log(`🎙️ Starting with pre-recorded greeting for call ${CallSid}`);
    
    // Play pre-recorded greeting instead of TTS
    const greetingUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/greet.mp3`;
    
    // Gather speech input immediately after greeting
    const gather = twiml.gather({
      input: 'speech',
      timeout: 15,
      speechTimeout: 3,
      action: `/voice-response/${CallSid}`,
      method: 'POST',
      enhanced: true,
      language: 'en-US'
    });
    
    // Play the greeting as part of the gather
    gather.play(greetingUrl);
    
    // Fallback if no response - use pre-recorded audio for consistency
    twiml.gather({
      input: 'speech',
      timeout: 15,
      speechTimeout: 3,
      action: `/voice-response/${CallSid}`,
      method: 'POST',
      enhanced: true,
      language: 'en-US'
    });
    
    // Final fallback - hang up with deny message if still no response
    const denyUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
    twiml.play(denyUrl);
    twiml.hangup();
    
    res.type('text/xml');
    res.send(twiml.toString());
    
  } catch (error) {
    console.error('Error handling voice webhook:', error);
    const denyUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
    twiml.play(denyUrl);
    twiml.hangup();
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// NEW ENDPOINT: Handle speech recognition results
app.post('/voice-response/:callSid', async (req, res) => {
  const callSid = req.params.callSid;
  const { SpeechResult, Confidence } = req.body;
  
  console.log(`🎤 Speech recognized for call ${callSid}: "${SpeechResult}" (confidence: ${Confidence})`);
  
  const twiml = new twilio.twiml.VoiceResponse();
  
  try {
    if (SpeechResult && SpeechResult.trim().length > 0) {
      // Process with text Gemini API and wait for response
      const processResult = await processWithTextGeminiSync(SpeechResult, callSid);
      
      if (processResult && processResult.twiml) {
        // Return the TwiML from processing
        res.type('text/xml');
        res.send(processResult.twiml);
      } else if (processResult === null) {
        // Call is on hold, don't send any TwiML to avoid overriding hold music
        console.log(`🔒 Call ${callSid} is on hold - not sending TwiML response`);
        res.type('text/xml');
        res.send('<Response></Response>'); // Minimal response to keep call alive
      } else {
        // Fallback if processing failed
        twiml.say({
          voice: 'Polly.Joanna'
        }, 'I\'m processing that information. Please hold on.');
        
        const gather = twiml.gather({
          input: 'speech',
          timeout: 15,
          speechTimeout: 3,
          action: `/voice-response/${callSid}`,
          method: 'POST',
          enhanced: true
        });
        
        res.type('text/xml');
        res.send(twiml.toString());
      }
      
    } else {
      // No speech detected, hang up with deny message - NO Twilio voice
      console.log(`❌ No speech detected for call ${callSid}, hanging up`);
      const denyUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
      twiml.play(denyUrl);
      twiml.hangup();
      
      res.type('text/xml');
      res.send(twiml.toString());
    }
    
  } catch (error) {
    console.error(`Error processing speech for call ${callSid}:`, error);
    
    // Error - hang up with deny message, NO Twilio voice
    const denyUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
    twiml.play(denyUrl);
    twiml.hangup();
    
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// Handle call status updates
app.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`Call ${CallSid} status: ${CallStatus}`);
  
  if (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'busy' || CallStatus === 'no-answer') {
    // Clean up all session data
    console.log(`🧹 Cleaning up data for call ${CallSid}`);
    callSessions.delete(CallSid);
    callStates.delete(CallSid);
    conversationHistory.delete(CallSid);
  }
  
  res.sendStatus(200);
});

// Handle SMS responses from recipient
app.post('/sms', async (req, res) => {
  const { Body, From } = req.body;
  const message = Body.toUpperCase().trim();
  
  console.log(`SMS received from ${From}: ${message}`);
  
  // Find the most recent call on hold or any call with SMS sent
  let activeCallSid = null;
  let targetCallState = null;
  for (const [callSid, state] of callStates) {
    if (state && state.smsSent) {
      activeCallSid = callSid;
      targetCallState = state;
      break; // Get the first call that has SMS sent
    }
  }
  
  const twiml = new twilio.twiml.MessagingResponse();
  
  if (message === 'ACCEPT') {
    console.log('Recipient accepted the call');
    if (activeCallSid && targetCallState && targetCallState.onHold) {
      try {
        // Forward the call to the recipient using pre-recorded audio
        const forwardTwiml = new twilio.twiml.VoiceResponse();
        const acceptedUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/accepted.mp3`;
        forwardTwiml.play(acceptedUrl);
        
        // Dial the recipient
        forwardTwiml.dial({
          timeout: 30,
          callerId: process.env.TWILIO_PHONE_NUMBER
        }, process.env.RECIPIENT_PHONE_NUMBER);
        
        // Update the call to forward it
        await twilioClient.calls(activeCallSid).update({
          twiml: forwardTwiml.toString()
        });
        
        // Clean up call state
        callStates.delete(activeCallSid);
        callSessions.delete(activeCallSid);
        conversationHistory.delete(activeCallSid);
        
        twiml.message('Call has been connected to you.');
        console.log(`Call ${activeCallSid} forwarded to recipient and state cleaned up`);
      } catch (error) {
        console.error('Error forwarding call:', error);
        twiml.message('Error connecting the call. Please try again.');
      }
    } else {
      twiml.message('No active call to connect.');
    }
  } else if (message === 'DENY') {
    console.log('Recipient denied the call');
    if (activeCallSid) {
      try {
        // Hang up the call with pre-recorded message
        const hangupTwiml = new twilio.twiml.VoiceResponse();
        const denyUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
        hangupTwiml.play(denyUrl);
        hangupTwiml.hangup();
        
        // Update the call to hang up
        await twilioClient.calls(activeCallSid).update({
          twiml: hangupTwiml.toString()
        });
        
        // Clean up all call state
        callStates.delete(activeCallSid);
        callSessions.delete(activeCallSid);
        conversationHistory.delete(activeCallSid);
        
        twiml.message('Call has been declined and ended.');
        console.log(`Call ${activeCallSid} hung up due to DENY and state cleaned up`);
      } catch (error) {
        console.error('Error hanging up call:', error);
        twiml.message('Error ending the call.');
      }
    } else {
      twiml.message('No active call to end.');
    }
  } else if (message === 'BLOCK') {
    console.log('Recipient wants to block the caller');
    if (activeCallSid && targetCallState) {
      try {
        const callerNumber = targetCallState.from || 'Unknown';
        const callerName = targetCallState.callerName || 'Unknown Caller';
        
        // Hang up the call if still active
        if (targetCallState.onHold) {
          const hangupTwiml = new twilio.twiml.VoiceResponse();
          const denyUrl = `${process.env.PUBLIC_URL || 'https://twilio-call-screening.loca.lt'}/audio/deny.mp3`;
          hangupTwiml.play(denyUrl);
          hangupTwiml.hangup();
          
          await twilioClient.calls(activeCallSid).update({
            twiml: hangupTwiml.toString()
          });
        }
        
        // TODO: Add caller to block list (implement your blocking logic here)
        // For now, just log and acknowledge
        console.log(`📵 BLOCKED: ${callerNumber} (${callerName})`);
        
        // Clean up all call state
        callStates.delete(activeCallSid);
        callSessions.delete(activeCallSid);
        conversationHistory.delete(activeCallSid);
        
        twiml.message(`Number ${callerNumber} has been blocked and call ended. Future calls from this number will be automatically rejected.`);
        console.log(`Call ${activeCallSid} hung up and number ${callerNumber} blocked`);
      } catch (error) {
        console.error('Error blocking caller:', error);
        twiml.message('Error blocking the caller.');
      }
    } else {
      twiml.message('No active call to block.');
    }
  } else {
    twiml.message('Please reply with ACCEPT to connect, DENY to decline, or BLOCK to block this number permanently.');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Additional utility endpoints can be added here if needed

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeCalls: callSessions.size,
    fish_audio_configured: !!process.env.FISH_AUDIO_API_KEY,
    prerecorded_audio_files: ['greet.mp3', 'hold.mp3', 'deny.mp3', 'accepted.mp3'].map(file => 
      fs.existsSync(path.join(__dirname, 'audio', file)) ? file : `MISSING: ${file}`
    )
  });
});

// Test Fish Audio TTS endpoint
app.get('/test-fish-audio', async (req, res) => {
  try {
    const testText = req.query.text || "Hello, this is a test of Fish Audio TTS";
    console.log(`🧪 Testing Fish Audio TTS with text: "${testText}"`);
    
    const audioBuffer = await generateFishAudioTTS(testText);
    
    if (audioBuffer) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audioBuffer.length);
      res.send(audioBuffer);
      console.log(`✅ Fish Audio TTS test successful, generated ${audioBuffer.length} bytes`);
    } else {
      res.status(500).json({ error: 'Failed to generate Fish Audio TTS' });
    }
  } catch (error) {
    console.error('❌ Fish Audio TTS test failed:', error);
    res.status(500).json({ error: 'Fish Audio TTS test failed', details: error.message });
  }
});

// Hold music endpoint - serves the local hold music file
app.get('/hold-music', (req, res) => {
  try {
    const holdDir = path.join(__dirname, 'hold');
    
    // Prioritize smaller files for instant playback, then 35-minute file
    const files = fs.readdirSync(holdDir).filter(file => file.endsWith('.mp3'));
    
    if (files.length === 0) {
      console.error('No MP3 files found in hold directory');
      return res.status(404).json({ error: 'Hold music file not found' });
    }
    
    // Priority: micro file, then tiny file, then compressed, then 35-minute file, then any MP3
    let selectedFile = files.find(file => file.includes('micro')) || 
                       files.find(file => file.includes('tiny')) || 
                       files.find(file => file.includes('compressed')) ||
                       files.find(file => file.includes('35min')) || 
                       files[0];
    const holdMusicPath = path.join(holdDir, selectedFile);
    
    // Check if file exists
    if (!fs.existsSync(holdMusicPath)) {
      console.error('Hold music file not found:', holdMusicPath);
      return res.status(404).json({ error: 'Hold music file not found' });
    }
    
    // Get file stats for Content-Length header
    const stats = fs.statSync(holdMusicPath);
    const fileSize = stats.size;
    
    // Handle range requests for better streaming
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunksize);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      
      const readStream = fs.createReadStream(holdMusicPath, { start, end });
      readStream.pipe(res);
    } else {
      // Set appropriate headers for audio streaming
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      
      // Stream the file
      const readStream = fs.createReadStream(holdMusicPath);
      readStream.pipe(res);
      
      readStream.on('error', (error) => {
        console.error('Error streaming hold music:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream hold music' });
        }
      });
    }
    
    console.log('🎵 Serving hold music file:', selectedFile, `(${Math.round(fileSize/1024/1024)}MB)`);
    
  } catch (error) {
    console.error('Error serving hold music:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Audio endpoint - serves pre-recorded audio files from /audio directory
app.get('/audio/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const audioPath = path.join(__dirname, 'audio', filename);
    
    console.log(`🎵 Request for pre-recorded audio file: ${filename}`);
    console.log(`🎵 Full path: ${audioPath}`);
    
    // Check if file exists
    if (!fs.existsSync(audioPath)) {
      console.error(`❌ Pre-recorded audio file not found: ${audioPath}`);
      return res.status(404).json({ error: 'Audio file not found' });
    }
    
    // Get file stats
    const stats = fs.statSync(audioPath);
    console.log(`🎵 File size: ${stats.size} bytes`);
    
    // Set appropriate headers for audio streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache pre-recorded files
    res.setHeader('Content-Length', stats.size);
    
    // Stream the file
    const readStream = fs.createReadStream(audioPath);
    readStream.pipe(res);
    
    readStream.on('error', (error) => {
      console.error('❌ Error streaming pre-recorded audio:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream audio' });
      }
    });
    
    readStream.on('end', () => {
      console.log(`✅ Successfully served pre-recorded audio file: ${filename}`);
    });
    
    console.log(`🎵 Serving pre-recorded audio file: ${filename}`);
    
  } catch (error) {
    console.error('Error serving pre-recorded audio:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Temp audio endpoint - serves temporary audio files generated by Fish Audio TTS
app.get('/temp-audio/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const tempAudioPath = path.join(__dirname, 'temp', filename);
    
    console.log(`🎵 Request for temp audio file: ${filename}`);
    console.log(`🎵 Full path: ${tempAudioPath}`);
    
    // Check if file exists
    if (!fs.existsSync(tempAudioPath)) {
      console.error(`❌ Temp audio file not found: ${tempAudioPath}`);
      return res.status(404).json({ error: 'Audio file not found' });
    }
    
    // Get file stats
    const stats = fs.statSync(tempAudioPath);
    console.log(`🎵 File size: ${stats.size} bytes`);
    
    // Set appropriate headers for audio streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Length', stats.size);
    
    // Stream the file
    const readStream = fs.createReadStream(tempAudioPath);
    readStream.pipe(res);
    
    readStream.on('error', (error) => {
      console.error('❌ Error streaming temp audio:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream audio' });
      }
    });
    
    readStream.on('end', () => {
      console.log(`✅ Successfully served temp audio file: ${filename}`);
    });
    
    console.log(`🎵 Serving temp audio file: ${filename}`);
    
  } catch (error) {
    console.error('Error serving temp audio:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Call screening server running on port ${port}`);
  console.log(`Webhook URL: http://localhost:${port}/voice`);
  console.log(`Status URL: http://localhost:${port}/status`);
  console.log(`SMS URL: http://localhost:${port}/sms`);
}); 