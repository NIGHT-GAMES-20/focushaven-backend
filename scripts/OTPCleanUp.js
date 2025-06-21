import cron from 'node-cron';

export default function OTPCleanup(client) {
  const collection = client.collection("otps");

  cron.schedule('0 * * * *', async () => {
    try {
      const now = Date.now();
      const result = await collection.deleteMany({ DeleteAt: { $lt: now } });
      if(result.deletedCount !== 0) {
        console.log(`[CRON] Deleted ${result.deletedCount} expired OTPs at ${new Date().toISOString()}`);
      }
    } catch (error) {
      console.error("[CRON] OTP cleanup failed:", error.message);
    }
  });
}