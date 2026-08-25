/**
 * @jest-environment node
 */

/**
 * [RELAY-44] Threshold logic for the DLQ/DeliveryLog silent-loss health check.
 *
 * WHY THIS TESTS THE PURE FUNCTION, NOT THE API ROUTE
 * -------------------------------------------------------
 * `evaluateDlqHealth` (lib/relay/dlqHealthCheck.ts) takes plain counts and returns a
 * verdict — no Prisma, no Sentry, no Postgres. That is deliberate: the property this
 * ticket cares about ("does the threshold math fire on the right numbers") lives
 * entirely in that function, and testing it directly means these cases run against the
 * REAL threshold constants with no live database, no Prisma mock, and no dependency on
 * whether local Postgres is available — unlike the RLS suites in this same directory,
 * which genuinely need one and skip without it.
 *
 * `collectDlqHealthMetrics` (the Prisma-querying half) and the API route's Sentry
 * wiring are exercised by inspection against the schema and Vercel/Sentry docs — see the
 * comments in dlqHealthCheck.ts and pages/api/relay/internal/dlq-health-check.ts — not
 * re-proven here, since neither has logic beyond "count these rows" / "call Sentry with
 * these args", and mocking Prisma to prove a COUNT query would test the mock, not Relay.
 */

import {
  evaluateDlqHealth,
  DLQ_GROWTH_ALERT_THRESHOLD,
  DELIVERY_FAILURE_RATIO_ALERT_THRESHOLD,
  DELIVERY_FAILURE_MIN_ATTEMPTS_FOR_RATIO,
  type DlqHealthMetrics,
} from '../../lib/relay/dlqHealthCheck';

const baseMetrics: DlqHealthMetrics = {
  newDlqCount: 0,
  totalDeliveryAttempts: 0,
  failedOrDlqDeliveryCount: 0,
};

describe('RELAY-44 — evaluateDlqHealth threshold logic', () => {
  describe('DLQ growth branch (traffic-independent floor)', () => {
    it('does not alert exactly at the threshold', () => {
      const result = evaluateDlqHealth({
        ...baseMetrics,
        newDlqCount: DLQ_GROWTH_ALERT_THRESHOLD,
      });

      expect(result.healthy).toBe(true);
      expect(result.reasons).not.toContain('dlq_growth_exceeded');
    });

    it('alerts one row above the threshold', () => {
      const result = evaluateDlqHealth({
        ...baseMetrics,
        newDlqCount: DLQ_GROWTH_ALERT_THRESHOLD + 1,
      });

      expect(result.healthy).toBe(false);
      expect(result.reasons).toContain('dlq_growth_exceeded');
    });

    it('does not alert well below the threshold', () => {
      const result = evaluateDlqHealth({ ...baseMetrics, newDlqCount: 3 });

      expect(result.healthy).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });
  });

  describe('delivery failure ratio branch (traffic-dependent)', () => {
    it('does not alert exactly at the ratio threshold', () => {
      // 15 / 100 = 15% == DELIVERY_FAILURE_RATIO_ALERT_THRESHOLD exactly — the
      // comparison is strictly-greater-than, so this must stay healthy.
      const total = 100;
      const failed = Math.round(total * DELIVERY_FAILURE_RATIO_ALERT_THRESHOLD);

      const result = evaluateDlqHealth({
        ...baseMetrics,
        totalDeliveryAttempts: total,
        failedOrDlqDeliveryCount: failed,
      });

      expect(result.failureRatio).toBeCloseTo(
        DELIVERY_FAILURE_RATIO_ALERT_THRESHOLD
      );
      expect(result.healthy).toBe(true);
      expect(result.reasons).not.toContain('delivery_failure_ratio_exceeded');
    });

    it('alerts just above the ratio threshold with enough traffic', () => {
      // 16 / 100 = 16% > 15%
      const result = evaluateDlqHealth({
        ...baseMetrics,
        totalDeliveryAttempts: 100,
        failedOrDlqDeliveryCount: 16,
      });

      expect(result.healthy).toBe(false);
      expect(result.reasons).toContain('delivery_failure_ratio_exceeded');
      expect(result.failureRatio).toBeCloseTo(0.16);
    });

    it('does not alert on a low failure ratio with plenty of traffic', () => {
      const result = evaluateDlqHealth({
        ...baseMetrics,
        totalDeliveryAttempts: 500,
        failedOrDlqDeliveryCount: 10, // 2%
      });

      expect(result.healthy).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('suppresses the ratio branch below the minimum-traffic guard even at 100% failure', () => {
      const total = DELIVERY_FAILURE_MIN_ATTEMPTS_FOR_RATIO - 1;

      const result = evaluateDlqHealth({
        ...baseMetrics,
        totalDeliveryAttempts: total,
        failedOrDlqDeliveryCount: total, // every single attempt failed
      });

      expect(result.healthy).toBe(true);
      expect(result.reasons).not.toContain('delivery_failure_ratio_exceeded');
      // Ratio is reported as null, not a computed number, when there isn't enough
      // traffic to trust it — distinguishes "checked and fine" from "not evaluated".
      expect(result.failureRatio).toBeNull();
    });

    it('evaluates the ratio branch at exactly the minimum-traffic guard', () => {
      const total = DELIVERY_FAILURE_MIN_ATTEMPTS_FOR_RATIO;
      const failed = total; // 100% failure, at the traffic floor exactly

      const result = evaluateDlqHealth({
        ...baseMetrics,
        totalDeliveryAttempts: total,
        failedOrDlqDeliveryCount: failed,
      });

      expect(result.failureRatio).toBe(1);
      expect(result.healthy).toBe(false);
      expect(result.reasons).toContain('delivery_failure_ratio_exceeded');
    });

    it('handles zero traffic without dividing by zero', () => {
      const result = evaluateDlqHealth({ ...baseMetrics });

      expect(result.failureRatio).toBeNull();
      expect(result.healthy).toBe(true);
    });
  });

  describe('both branches together', () => {
    it('reports both reasons when DLQ growth and failure ratio are both breached', () => {
      const result = evaluateDlqHealth({
        newDlqCount: DLQ_GROWTH_ALERT_THRESHOLD + 5,
        totalDeliveryAttempts: 50,
        failedOrDlqDeliveryCount: 40, // 80%
      });

      expect(result.healthy).toBe(false);
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          'dlq_growth_exceeded',
          'delivery_failure_ratio_exceeded',
        ])
      );
      expect(result.reasons).toHaveLength(2);
    });

    it('stays healthy when neither branch is breached', () => {
      const result = evaluateDlqHealth({
        newDlqCount: 5,
        totalDeliveryAttempts: 200,
        failedOrDlqDeliveryCount: 4, // 2%
      });

      expect(result.healthy).toBe(true);
      expect(result.reasons).toHaveLength(0);
      expect(result.metrics.newDlqCount).toBe(5);
    });
  });
});
