/**
 * Fish Audio TTS Pre-generation Script
 * 
 * Fish Audio Reference: https://fish.audio/
 * API Documentation: https://fish.audio/docs/
 * Voice ID used: dc21b4b6e8f04dfb99b9212985bc3515
 * 
 * This script generates all required pre-recorded audio files for the Twilio Call Screening system.
 * Run this script to generate audio files that other people can use without needing Fish Audio API access.
 */

const { Session, TTSRequest } = require('fish-audio-sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Fish Audio TTS Configuration
const FISH_AUDIO_CONFIG = {
  format: "mp3",
  mp3Bitrate: 128,
  sampleRate: 44100,
  chunkLength: 200,
  normalize: true,
  latency: "balanced",
  referenceId: "dc21b4b6e8f04dfb99b9212985bc3515", // Professional female voice
  model: 'speech-1.6'
};

// Audio files to generate
const AUDIO_FILES = {
  'greet.mp3': "Hello I'm an AI to Monitor for spam, or unwanted calls, May I please have your name and the reason for your call?",
  'hold.mp3': "I've passed your information onto the person you were trying to call, I'll now put you on hold while I wait for a response!",
  'deny.mp3': "The person you were trying to reach is currently unable to take your call, and has not responded within the timeframe. Please try again later.",
  'accepted.mp3': "You'll now be connected to the person you were trying to reach, as they've accepted the call."
};

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function colorLog(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Initialize Fish Audio session
function initializeFishAudio() {
  if (!process.env.FISH_AUDIO_API_KEY) {
    colorLog('red', '❌ ERROR: Fish Audio API key not found in .env file');
    colorLog('yellow', '💡 Please add FISH_AUDIO_API_KEY to your .env file');
    colorLog('cyan', '🔗 Get your API key from: https://fish.audio/');
    process.exit(1);
  }
  
  return new Session(process.env.FISH_AUDIO_API_KEY);
}

// Generate TTS audio using Fish Audio
async function generateFishAudioTTS(text, filename) {
  try {
    colorLog('blue', `🐟 Generating Fish Audio TTS for: "${text}"`);
    
    const fishAudioSession = initializeFishAudio();
    
    const request = new TTSRequest(text, {
      format: FISH_AUDIO_CONFIG.format,
      mp3Bitrate: FISH_AUDIO_CONFIG.mp3Bitrate,
      sampleRate: FISH_AUDIO_CONFIG.sampleRate,
      chunkLength: FISH_AUDIO_CONFIG.chunkLength,
      normalize: FISH_AUDIO_CONFIG.normalize,
      latency: FISH_AUDIO_CONFIG.latency,
      referenceId: FISH_AUDIO_CONFIG.referenceId,
    });

    const headers = { 
      model: FISH_AUDIO_CONFIG.model
    };

    const audioChunks = [];
    
    colorLog('cyan', `📥 Receiving audio chunks for ${filename}...`);
    for await (const chunk of fishAudioSession.tts(request, headers)) {
      audioChunks.push(chunk);
    }
    
    if (audioChunks.length > 0) {
      colorLog('green', `✅ Fish Audio TTS generated ${audioChunks.length} chunks for ${filename}`);
      return Buffer.concat(audioChunks);
    }
    
    colorLog('red', `❌ No audio chunks received for ${filename}`);
    return null;
    
  } catch (error) {
    colorLog('red', `❌ Error generating Fish Audio TTS for ${filename}:`);
    console.error(error.message);
    return null;
  }
}

// Save audio buffer to file
async function saveAudioFile(audioBuffer, filename) {
  try {
    const audioDir = path.join(__dirname, 'audio');
    
    // Create audio directory if it doesn't exist
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
      colorLog('green', `📁 Created audio directory: ${audioDir}`);
    }
    
    const filepath = path.join(audioDir, filename);
    fs.writeFileSync(filepath, audioBuffer);
    
    const fileSizeKB = Math.round(audioBuffer.length / 1024);
    colorLog('green', `💾 Saved ${filename} (${fileSizeKB} KB) to ${filepath}`);
    
    return true;
  } catch (error) {
    colorLog('red', `❌ Error saving ${filename}:`);
    console.error(error.message);
    return false;
  }
}

// Generate all audio files
async function generateAllAudioFiles() {
  colorLog('bright', '🎵 Starting Fish Audio TTS Pre-generation...');
  colorLog('cyan', `🔧 Using voice ID: ${FISH_AUDIO_CONFIG.referenceId}`);
  colorLog('cyan', `📊 Audio format: ${FISH_AUDIO_CONFIG.format.toUpperCase()}, ${FISH_AUDIO_CONFIG.mp3Bitrate}kbps, ${FISH_AUDIO_CONFIG.sampleRate}Hz`);
  
  let successCount = 0;
  let totalFiles = Object.keys(AUDIO_FILES).length;
  
  for (const [filename, text] of Object.entries(AUDIO_FILES)) {
    colorLog('yellow', `\n📢 Processing ${filename}...`);
    
    // Generate audio
    const audioBuffer = await generateFishAudioTTS(text, filename);
    
    if (audioBuffer) {
      // Save to file
      const saved = await saveAudioFile(audioBuffer, filename);
      if (saved) {
        successCount++;
        colorLog('green', `✅ Successfully generated ${filename}`);
      }
    } else {
      colorLog('red', `❌ Failed to generate ${filename}`);
    }
    
    // Add small delay between requests to be respectful to the API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Final summary
  colorLog('bright', `\n🎉 Generation Complete!`);
  colorLog('green', `✅ Successfully generated: ${successCount}/${totalFiles} files`);
  
  if (successCount === totalFiles) {
    colorLog('green', '🎊 All audio files generated successfully!');
    colorLog('cyan', '📁 Files saved to: ./audio/');
    colorLog('yellow', '💡 You can now share these files with others who need them.');
  } else {
    colorLog('red', `❌ ${totalFiles - successCount} files failed to generate`);
  }
}

// Verify existing audio files
function verifyExistingFiles() {
  colorLog('bright', '\n🔍 Checking existing audio files...');
  
  const audioDir = path.join(__dirname, 'audio');
  const existingFiles = [];
  
  if (fs.existsSync(audioDir)) {
    for (const filename of Object.keys(AUDIO_FILES)) {
      const filepath = path.join(audioDir, filename);
      if (fs.existsSync(filepath)) {
        const stats = fs.statSync(filepath);
        const fileSizeKB = Math.round(stats.size / 1024);
        existingFiles.push({ filename, size: fileSizeKB });
        colorLog('green', `✅ ${filename} exists (${fileSizeKB} KB)`);
      } else {
        colorLog('red', `❌ ${filename} missing`);
      }
    }
  } else {
    colorLog('yellow', '📁 Audio directory does not exist');
  }
  
  return existingFiles;
}

// Main execution
async function main() {
  try {
    colorLog('bright', '🎵 Fish Audio TTS Pre-generation Tool');
    colorLog('cyan', '🔗 Fish Audio: https://fish.audio/');
    colorLog('cyan', '📖 Documentation: https://fish.audio/docs/');
    
    // Check for existing files
    const existingFiles = verifyExistingFiles();
    
    // Ask user if they want to regenerate existing files
    if (existingFiles.length > 0) {
      colorLog('yellow', `\n⚠️  Found ${existingFiles.length} existing audio files`);
      colorLog('yellow', '   Run with --force to regenerate all files');
      
      const forceRegenerate = process.argv.includes('--force');
      if (!forceRegenerate) {
        colorLog('cyan', '💡 To regenerate all files, run: node pregen-audio.js --force');
        colorLog('green', '✅ All required files already exist. Exiting.');
        return;
      }
    }
    
    // Generate all files
    await generateAllAudioFiles();
    
  } catch (error) {
    colorLog('red', '❌ Unexpected error occurred:');
    console.error(error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = {
  generateFishAudioTTS,
  saveAudioFile,
  generateAllAudioFiles,
  AUDIO_FILES,
  FISH_AUDIO_CONFIG
};
