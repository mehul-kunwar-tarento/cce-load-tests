// Flood: the stress for queue-fed services (test plan D1, D5). Far more events than the service can read,
// 2,000 per second for 1 minute (120,000), right after the 30-second smoke. The service then works at its
// maximum until the queue is empty, and that maximum is its breaking point.
export const floodScenario = {
  executor: 'constant-arrival-rate',
  rate: 2000,
  timeUnit: '1s',
  duration: '1m',
  startTime: '30s',
  preAllocatedVUs: 100, // writing to Kafka takes well under a millisecond, so few are needed
  maxVUs: 1000,
};
