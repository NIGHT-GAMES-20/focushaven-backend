import sharp from 'sharp';
import fs from 'fs/promises';

const TARGET_SIZE_KB = 50;

async function compressWithEstimate(inputPath, outputPath) {
  const inputBuffer = await fs.readFile(inputPath);
  const originalSizeKB = inputBuffer.length / 1024;

  if (originalSizeKB <= TARGET_SIZE_KB) {
    console.log('✅ Image already under target size');
    await fs.writeFile(outputPath, inputBuffer);
    return;
  }

  // Estimate quality using linear scaling
  let estimatedQuality = Math.ceil((TARGET_SIZE_KB / originalSizeKB) * 100);
  estimatedQuality = Math.max(10, Math.min(100, estimatedQuality));

  const outputBuffer = await sharp(inputBuffer)
    .jpeg({ quality: estimatedQuality })
    .toBuffer();

  const finalSizeKB = outputBuffer.length / 1024;
  await fs.writeFile(outputPath, outputBuffer);

  console.log(`✅ Compressed to ~${finalSizeKB.toFixed(1)}KB using estimated quality ${estimatedQuality}`);
}

compressWithEstimate('./output.jpg', './output1.jpg');
