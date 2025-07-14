const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Audio cutting configuration
const HOLD_DIR = path.join(__dirname, 'hold');
const TARGET_DURATION = '35:18'; // 35 minutes 18 seconds
const OUTPUT_FILENAME = 'hold-music-35min.mp3';

async function cutAudioFile() {
  try {
    console.log('🎵 Audio File Cutter for Twilio');
    console.log('================================');
    
    // Find the existing MP3 file
    const files = fs.readdirSync(HOLD_DIR).filter(file => file.endsWith('.mp3'));
    
    if (files.length === 0) {
      console.error('❌ No MP3 files found in hold directory');
      return;
    }
    
    const inputFile = files[0];
    const inputPath = path.join(HOLD_DIR, inputFile);
    const outputPath = path.join(HOLD_DIR, OUTPUT_FILENAME);
    
    console.log(`📂 Input file: ${inputFile}`);
    console.log(`📂 Output file: ${OUTPUT_FILENAME}`);
    console.log(`⏱️  Target duration: ${TARGET_DURATION}`);
    console.log('');
    
    // Check if output file already exists
    if (fs.existsSync(outputPath)) {
      console.log('⚠️  Output file already exists. Removing...');
      fs.unlinkSync(outputPath);
    }
    
    // Check file size
    const stats = fs.statSync(inputPath);
    const fileSizeMB = Math.round(stats.size / (1024 * 1024));
    console.log(`📊 Original file size: ${fileSizeMB}MB`);
    
    console.log('✂️  Cutting audio file...');
    console.log('   This may take a few minutes for large files...');
    
    // FFmpeg command to cut the file
    const ffmpegCommand = `ffmpeg -i "${inputPath}" -t ${TARGET_DURATION} -c copy "${outputPath}"`;
    
    console.log(`🔧 Running: ${ffmpegCommand}`);
    console.log('');
    
    exec(ffmpegCommand, (error, stdout, stderr) => {
      if (error) {
        console.error('❌ Error cutting audio file:', error);
        console.error('💡 Make sure FFmpeg is installed:');
        console.error('   Windows: Download from https://ffmpeg.org/download.html');
        console.error('   Or install via: winget install Gyan.FFmpeg');
        return;
      }
      
      if (stderr) {
        console.log('🔧 FFmpeg output:', stderr);
      }
      
      // Check if output file was created
      if (fs.existsSync(outputPath)) {
        const outputStats = fs.statSync(outputPath);
        const outputSizeMB = Math.round(outputStats.size / (1024 * 1024));
        
        console.log('✅ Audio file cut successfully!');
        console.log(`📂 New file: ${OUTPUT_FILENAME}`);
        console.log(`📊 New file size: ${outputSizeMB}MB`);
        console.log(`⏱️  Duration: ${TARGET_DURATION}`);
        console.log('');
        console.log('🎯 Next steps:');
        console.log('1️⃣ Update your server to use the new file');
        console.log('2️⃣ Test with: node test.js call hold');
        console.log('');
        console.log('💡 The new file is under 40 minutes so Twilio can play it!');
      } else {
        console.error('❌ Output file was not created');
      }
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Command line interface
const args = process.argv.slice(2);
const command = args[0];

if (command === 'cut') {
  cutAudioFile();
} else {
  console.log('🎵 Audio File Cutter for Twilio');
  console.log('================================');
  console.log('');
  console.log('📋 This script cuts your 8-hour music file to 35:18 minutes');
  console.log('   (Under Twilio\'s 40-minute limit to prevent dropped calls)');
  console.log('');
  console.log('🔧 Prerequisites:');
  console.log('   ✅ FFmpeg installed (for audio processing)');
  console.log('   ✅ Your 8-hour MP3 file in the hold/ directory');
  console.log('');
  console.log('🚀 Usage:');
  console.log('   node cut-audio.js cut');
  console.log('');
  console.log('💡 Install FFmpeg:');
  console.log('   Windows: winget install Gyan.FFmpeg');
  console.log('   Or download from: https://ffmpeg.org/download.html');
} 