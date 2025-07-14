// Enhanced Gemini Client for Call Screening
// To run this code you need to install the following dependencies:
// npm install @google/genai mime
// npm install -D @types/node
const {
  GoogleGenAI,
  LiveServerMessage,
  MediaResolution,
  Modality,
  Session,
  Type,
} = require('@google/genai');
const mime = require('mime');
const { writeFile, readFileSync } = require('fs');
const path = require('path');
require('dotenv').config();

const responseQueue = [];
let session = undefined;

async function handleTurn() {
  const turn = [];
  let done = false;
  while (!done) {
    const message = await waitMessage();
    turn.push(message);
    if (message.serverContent && message.serverContent.turnComplete) {
      done = true;
    }
  }
  return turn;
}

async function waitMessage() {
  let done = false;
  let message = undefined;
  while (!done) {
    message = responseQueue.shift();
    if (message) {
      handleModelTurn(message);
      done = true;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return message;
}

const audioParts = [];
function handleModelTurn(message) {
  if (message.toolCall) {
    message.toolCall.functionCalls?.forEach(
      functionCall => {
        console.log(`Execute function ${functionCall.name} with arguments: ${JSON.stringify(functionCall.args)}`);
        
        // Handle the function calls
        let response;
        switch (functionCall.name) {
          case 'SMSInfo':
            const { name, summary } = functionCall.args;
            response = `SMS would be sent: Caller: ${name}, Reason: ${summary}`;
            break;
          case 'OnHold':
            response = 'Call placed on hold';
            break;
          case 'Hangup':
            response = 'Call terminated';
            break;
          case 'Forward':
            response = 'Call forwarded';
            break;
          default:
            response = 'Unknown function';
        }
        
        return response;
      }
    );

    session?.sendToolResponse({
      functionResponses:
        message.toolCall.functionCalls?.map(functionCall => ({
          id: functionCall.id,
          name: functionCall.name,
          response: { response: handleFunctionCall(functionCall) }
        })) ?? []
    });
  }

  if (message.serverContent?.modelTurn?.parts) {
    const part = message.serverContent?.modelTurn?.parts?.[0];

    if (part?.fileData) {
      console.log(`File: ${part?.fileData.fileUri}`);
    }

    if (part?.inlineData) {
      const fileName = 'audio.wav';
      const inlineData = part?.inlineData;

      audioParts.push(inlineData?.data ?? '');

      const buffer = convertToWav(audioParts, inlineData.mimeType ?? '');
      saveBinaryFile(fileName, buffer);
    }

    if (part?.text) {
      console.log('AI Response:', part?.text);
    }
  }
}

function handleFunctionCall(functionCall) {
  const { name, args } = functionCall;
  
  switch (name) {
    case 'SMSInfo':
      const { name: callerName, summary } = args;
      return `SMS sent: Caller: ${callerName}, Reason: ${summary}`;
    case 'OnHold':
      return 'Call placed on hold';
    case 'Hangup':
      return 'Call terminated';
    case 'Forward':
      return 'Call forwarded';
    default:
      return 'Unknown function';
  }
}

function saveBinaryFile(fileName, content) {
  writeFile(fileName, content, 'utf8', (err) => {
    if (err) {
      console.error(`Error writing file ${fileName}:`, err);
      return;
    }
    console.log(`Appending stream content to file ${fileName}.`);
  });
}

function convertToWav(rawData, mimeType) {
  const options = parseMimeType(mimeType);
  const dataLength = rawData.reduce((a, b) => a + b.length, 0);
  const wavHeader = createWavHeader(dataLength, options);
  const buffer = Buffer.concat(rawData.map(data => Buffer.from(data, 'base64')));

  return Buffer.concat([wavHeader, buffer]);
}

function parseMimeType(mimeType) {
  const [fileType, ...params] = mimeType.split(';').map(s => s.trim());
  const [_, format] = fileType.split('/');

  const options = {
    numChannels: 1,
    bitsPerSample: 16,
    sampleRate: 8000,
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

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

async function main() {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  const model = 'models/gemini-2.5-flash-preview-native-audio-dialog';

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
          name: 'Hangup',
          description: 'Terminates the current call. Only use if the user sends \'DENY\' via text.',
          parameters: {
            type: Type.OBJECT,
            properties: {},
          },
        },
        {
          name: 'Forward',
          description: 'Forwards the current call to the intended recipient. DO NOT use unless explicitly instructed by the recipient.',
          parameters: {
            type: Type.OBJECT,
            properties: {},
          },
        },
        {
          name: 'OnHold',
          description: 'Places the current caller on hold. This should be called immediately after obtaining the caller\'s name and reason, and before sending the SMSInfo.',
          parameters: {
            type: Type.OBJECT,
            properties: {},
          },
        },
      ],
    }
  ];

  // Read system prompt from file
  const systemPrompt = readFileSync(path.join(__dirname, 'prompt.txt'), 'utf8');

  const config = {
    responseModalities: [
      Modality.AUDIO,
    ],
    mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: 'Zephyr',
        }
      }
    },
    contextWindowCompression: {
      triggerTokens: '25600',
      slidingWindow: { targetTokens: '12800' },
    },
    tools,
    systemInstruction: {
      parts: [{
        text: systemPrompt,
      }]
    },
  };

  session = await ai.live.connect({
    model,
    callbacks: {
      onopen: function () {
        console.debug('Gemini session opened');
      },
      onmessage: function (message) {
        responseQueue.push(message);
      },
      onerror: function (e) {
        console.debug('Error:', e.message);
      },
      onclose: function (e) {
        console.debug('Close:', e.reason);
      },
    },
    config
  });

  // Send initial greeting
  session.sendClientContent({
    turns: [
      {
        role: 'user',
        parts: [
          {
            text: 'A caller has connected to the call screening system. Begin the screening process.'
          }
        ]
      }
    ]
  });

  await handleTurn();

  session.close();
}

// Run the main function if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  main,
  handleTurn,
  handleModelTurn,
  convertToWav,
  parseMimeType,
  createWavHeader
}; 