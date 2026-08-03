-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('ACTIVE', 'PAUSED', 'FAILING');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'DELIVERED', 'RETRYING', 'FAILED', 'DLQ');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'TIMED_OUT');

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "maxRetries" INTEGER NOT NULL DEFAULT 7,
    "status" "RouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryLog" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sourceIp" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "responseCode" INTEGER,
    "latencyMs" INTEGER,
    "payloadSizeB" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(6),

    CONSTRAINT "DeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DlqItem" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "failReason" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "payload" JSONB,
    "payloadKey" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "retriedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DlqItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateRule" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "condition" JSONB NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "timeoutMins" INTEGER NOT NULL DEFAULT 60,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GateRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "gateRuleId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "riskLevel" "RiskLevel" NOT NULL,
    "approvedBy" TEXT,
    "rejectedBy" TEXT,
    "resolvedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "inngestRunId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "target" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Route_teamId_slug_key" ON "Route"("teamId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryLog_requestId_key" ON "DeliveryLog"("requestId");

-- CreateIndex
CREATE INDEX "DeliveryLog_routeId_createdAt_idx" ON "DeliveryLog"("routeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DeliveryLog_routeId_status_createdAt_idx" ON "DeliveryLog"("routeId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DlqItem_routeId_createdAt_idx" ON "DlqItem"("routeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DlqItem_expiresAt_idx" ON "DlqItem"("expiresAt");

-- CreateIndex
CREATE INDEX "GateRule_teamId_active_idx" ON "GateRule"("teamId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_requestId_key" ON "ApprovalRequest"("requestId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_teamId_status_createdAt_idx" ON "ApprovalRequest"("teamId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ApprovalRequest_expiresAt_idx" ON "ApprovalRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_gateRuleId_idx" ON "ApprovalRequest"("gateRuleId");

-- CreateIndex
CREATE INDEX "AuditLog_teamId_createdAt_idx" ON "AuditLog"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_teamId_event_createdAt_idx" ON "AuditLog"("teamId", "event", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryLog" ADD CONSTRAINT "DeliveryLog_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DlqItem" ADD CONSTRAINT "DlqItem_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateRule" ADD CONSTRAINT "GateRule_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_gateRuleId_fkey" FOREIGN KEY ("gateRuleId") REFERENCES "GateRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
