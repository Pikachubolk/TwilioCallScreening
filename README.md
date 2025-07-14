# Twilio Call Screening System with Google Gemini AI

This project implements an AI-powered call screening system using Twilio for call handling and Google Gemini for intelligent conversation processing. The system screens incoming calls, gathers caller information, and sends SMS alerts to help you decide whether to accept or deny calls.

## Features

- **AI-Powered Call Screening**: Uses Google Gemini to have natural conversations with callers
- **Pre-recorded Audio**: Professional greeting, hold, deny, and accept messages for instant playback
- **Automatic Spam Detection**: AI detects and auto-hangs up on obvious spam calls
- **SMS Notifications**: Sends caller information with phone number via SMS
- **Accept/Deny/Block Responses**: Reply to SMS with ACCEPT, DENY, or BLOCK to control call flow
- **Fish Audio TTS**: High-quality text-to-speech for dynamic AI responses (no Twilio voice)
- **Intelligent Conversation**: AI varies responses and can handle questions while staying on-task
- **Hold Music**: Plays background music while caller is on hold

## System Architecture

```
[Incoming Call] → [Twilio] → [Node.js Server] → [Google Gemini AI]
                      ↓
[SMS Alert] ← [Recipient] ← [Call Information]
                      ↓
[Accept/Deny] → [Call Routing/Termination]
```

## Prerequisites

- Node.js (v18 or higher)
- Twilio account with phone number
- Google Gemini API key
- Fish Audio API key (for TTS)
- Public URL for webhooks (use ngrok or localtunnel for local development)

## Setup Instructions

### 1. Server Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Create a `.env` file and fill in your credentials:
   ```env
   TWILIO_ACCOUNT_SID=your_twilio_account_sid
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   TWILIO_PHONE_NUMBER=your_twilio_phone_number
   GEMINI_API_KEY=your_gemini_api_key
   FISH_AUDIO_API_KEY=your_fish_audio_api_key
   RECIPIENT_PHONE_NUMBER=your_phone_number
   PORT=3000
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

### 2. Twilio Configuration

1. **Set up webhooks in Twilio Console:**
   - Voice webhook URL: `https://your-domain.com/voice`
   - SMS webhook URL: `https://your-domain.com/sms`
   - Status callback URL: `https://your-domain.com/status`

2. **For local development with localtunnel:**
   ```bash
   npx localtunnel --port 3000 --subdomain twilio-call-screening
   ```
   Use the generated URL for your webhook endpoints.

### 3. Audio Files Setup
⚠️ Warning: These audio files are not included in the repository

1. **Pre-recorded messages in the `audio/` directory:**
   - `greet.mp3` - Initial greeting and request for information
   - `hold.mp3` - Message played when putting caller on hold
   - `deny.mp3` - Message played when denying/hanging up on calls
   - `accepted.mp3` - Message played when connecting call to recipient
   - These files are served at `/audio/:filename` endpoints

2. **Hold music in the `hold/` directory:**
   - Supported format: MP3
   - Recommended: Files under 40 minutes (Twilio limit)
   - File will be served at `/hold-music` endpoint

## How It Works

### Call Flow

1. **Incoming Call**: When someone calls your Twilio number, the system:
   - Connects the caller to the AI screening system
   - Greets the caller and asks for their name and reason for calling

2. **AI Screening**: The Google Gemini AI:
   - Conducts a natural conversation with the caller
   - Gathers the caller's name and reason for calling
   - Places the caller on hold with music
   - Sends caller information via SMS

3. **SMS Alert**: You receive an SMS with:
   - Caller's name
   - Reason for calling
   - Call ID for tracking
   - Instructions to reply ACCEPT or DENY

4. **Response Handling**: Based on your SMS reply:
   - **ACCEPT**: Call is forwarded to your phone with acceptance message
   - **DENY**: Call is terminated with polite deny message
   - **BLOCK**: Call is terminated and number is flagged for future blocking

### AI Behavior

The AI assistant is programmed to:
- Use pre-recorded greeting instead of introducing itself
- Politely request caller information with varied language
- Automatically detect and hang up on obvious spam calls
- Send spam alerts with caller phone numbers for important blocked calls
- Maintain professional but conversational tone
- Handle questions and clarifications while staying focused on screening
- Use intelligent information extraction to avoid repetitive questions
- Never repeat the same phrases - always vary responses

## API Endpoints

### Server Endpoints

- `POST /voice` - Twilio voice webhook
- `POST /sms` - Twilio SMS webhook (accepts ACCEPT, DENY, BLOCK responses)
- `POST /status` - Call status updates
- `GET /health` - Health check
- `GET /audio/:filename` - Serve pre-recorded audio files (greet.mp3, hold.mp3, deny.mp3, accepted.mp3)
- `GET /hold-music` - Serve hold music file
- `GET /temp-audio/:filename` - Serve temporary Fish Audio TTS files
- `GET /test-fish-audio` - Test Fish Audio TTS generation

## Configuration

### Customizing AI Behavior

Edit `prompt.txt` to modify the AI's:
- Greeting message
- Conversation style
- Spam detection criteria
- Response patterns

### Twilio Settings

Configure in Twilio Console:
- Voice recordings
- Call forwarding options
- SMS settings
- Geographic permissions

## Testing

### Local Testing

1. **Start the server:**
   ```bash
   npm run dev
   ```

2. **Test with localtunnel:**
   ```bash
   npx localtunnel --port 3000 --subdomain twilio-call-screening
   ```

3. **Test Fish Audio TTS:**
   ```bash
   curl "http://localhost:3000/test-fish-audio?text=Hello%20World"
   ```

4. **Test hold music:**
   ```bash
   node test.js call hold
   ```

5. **Run test suite:**
   ```bash
   node test-client.js
   ```

### Production Deployment

1. **Deploy to cloud platform (Heroku, AWS, etc.)**
2. **Update Twilio webhooks with production URLs**
3. **Configure SSL certificates**
4. **Set up monitoring and logging**

## Troubleshooting

### Common Issues

1. **Gemini API errors**: Check API key and quota limits
2. **Twilio webhook failures**: Verify URL accessibility and SSL
3. **SMS not received**: Check phone number format and carrier
4. **Fish Audio TTS errors**: Verify API key and model version
5. **Pre-recorded audio not playing**: Check that audio files exist in `/audio/` directory
6. **Hold music not playing**: Check file format and size (under 40MB)
7. **Spam detection too aggressive**: Adjust spam keywords in prompt.txt
8. **BLOCK responses not working**: Check SMS webhook is properly configured

### Debugging

- Check server logs for webhook events
- Monitor Twilio debugger for call issues
- Test API endpoints with curl or Postman
- Use `/health` endpoint to check system status

## Security Considerations

- **API Keys**: Store securely in `.env` file, never commit to version control
- **Webhook Security**: Validate Twilio signatures
- **SMS Security**: Implement rate limiting
- **Data Privacy**: Handle caller information responsibly
- **Temporary Files**: Audio files are automatically cleaned up


### Planned Features

1. **Additional Provider Support**
   - [ ] Support for Vonage/Nexmo integration
   - [ ] Support for Amazon Connect
   - [ ] Support for Plivo
   - [ ] Support for SignalWire

2. **Alternative Voice Providers**
   - [ ] Support for Amazon Polly TTS
   - [ ] Support for Google Cloud Text-to-Speech
   - [ ] Support for Microsoft Azure Speech Services
   - [ ] Support for Eleven Labs voice synthesis
   - [ ] Support for Speechify Text-to-Speech

3. **AI Model Integration**
   - [ ] OpenAI GPT integration
   - [ ] Support for OpenAI endpoints
   - [ ] Support for Anthropic Claude
   - [ ] Support for local LLM deployment
   - [ ] Model switching capabilities


## License

This project is licensed under the MIT License.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## Support

For issues and questions:
- Check the troubleshooting section
- Review Twilio documentation
- Check Google Gemini API documentation
- Check Fish Audio API documentation
- Open an issue on GitHub

## Disclaimer

This system is for educational and personal use. Ensure compliance with local laws and regulations regarding call recording and privacy. 