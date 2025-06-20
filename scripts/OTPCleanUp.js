import cron from 'node-cron';

export default function OTPCleanup(client) {
  const collection = client.collection("otps");

  // Run daily at 3:00 AM (server time)
  cron.schedule('0 * * * *', async () => {
    try {
      const now = Date.now();
      const result = await collection.deleteMany({ DeleteAt: { $lt: now } });
      console.log(`[CRON] Deleted ${result.deletedCount} expired OTPs at 3 AM`);
    } catch (error) {
      console.error("[CRON] OTP cleanup failed:", error.message);
    }
  });
}