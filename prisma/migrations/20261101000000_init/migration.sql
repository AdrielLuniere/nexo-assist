-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('EMPLOYEE', 'ANALYST');

-- CreateEnum
CREATE TYPE "AnalystLevel" AS ENUM ('N1', 'N2');

-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('INC', 'REQ');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('ACCESS', 'NETWORK_VPN', 'HARDWARE', 'SOFTWARE', 'EMAIL', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('WAITING_ANALYST', 'IN_PROGRESS', 'APPROVED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AffectedScope" AS ENUM ('INDIVIDUAL', 'TEAM', 'COMPANY');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('WITH_AGENT', 'WAITING_ANALYST', 'WITH_ANALYST', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('EMPLOYEE', 'AGENT', 'ANALYST', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('EMPLOYEE', 'AGENT', 'ANALYST', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TicketEventType" AS ENUM ('CREATED', 'UPDATED', 'COMMENT_ADDED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'REOPENED', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "DraftOperation" AS ENUM ('CREATE', 'UPDATE', 'REOPEN');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISCARDED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "HandoffReason" AS ENUM ('EMPLOYEE_REQUEST', 'CRITICAL_ISSUE', 'OVERDUE_TICKET', 'LOW_CONFIDENCE');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('WAITING', 'ASSUMED', 'RETURNED_TO_AGENT', 'CLOSED');

-- CreateEnum
CREATE TYPE "AgentIntent" AS ENUM ('ASK_QUESTION', 'CHECK_TICKET_STATUS', 'UPDATE_TICKET', 'OPEN_TICKET', 'REOPEN_TICKET', 'TALK_TO_ANALYST', 'OUT_OF_SCOPE', 'SMALL_TALK', 'UNCLEAR');

-- CreateEnum
CREATE TYPE "AgentAction" AS ENUM ('ANSWER_FROM_HELP_CENTER', 'SHOW_TICKETS', 'ASK_TICKET_SELECTION', 'ASK_CLARIFICATION', 'PROPOSE_TICKET_DRAFT', 'PROPOSE_TICKET_UPDATE', 'PROPOSE_TICKET_REOPEN', 'TRANSFER_TO_ANALYST', 'REDIRECT_OUT_OF_SCOPE', 'REPLY');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'EMPLOYEE',
    "analystLevel" "AnalystLevel",
    "department" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'WITH_AGENT',
    "assignedAnalystId" TEXT,
    "title" TEXT,
    "summary" TEXT,
    "employeeMessageCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "authorId" TEXT,
    "content" TEXT NOT NULL,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "clientMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "TicketType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "priority" "TicketPriority" NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'WAITING_ANALYST',
    "affectedScope" "AffectedScope" NOT NULL,
    "affectedDescription" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "originConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "type" "TicketEventType" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "draftId" TEXT,
    "comment" TEXT,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_sequences" (
    "type" "TicketType" NOT NULL,
    "lastNumber" INTEGER NOT NULL,

    CONSTRAINT "ticket_sequences_pkey" PRIMARY KEY ("type")
);

-- CreateTable
CREATE TABLE "help_articles" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "TicketCategory",
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "help_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_drafts" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "operation" "DraftOperation" NOT NULL,
    "targetTicketId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "resultTicketId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_decisions" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "triggerMessageId" TEXT,
    "intent" "AgentIntent" NOT NULL,
    "understanding" TEXT NOT NULL,
    "action" "AgentAction" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,
    "ruleRefs" TEXT[],
    "steps" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handoffs" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "reason" "HandoffReason" NOT NULL,
    "status" "HandoffStatus" NOT NULL DEFAULT 'WAITING',
    "requestedBy" "ActorType" NOT NULL,
    "summary" TEXT NOT NULL,
    "relatedTicketId" TEXT,
    "assumedById" TEXT,
    "assumedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "conversations_employeeId_updatedAt_idx" ON "conversations"("employeeId", "updatedAt");

-- CreateIndex
CREATE INDEX "conversations_status_updatedAt_idx" ON "conversations"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversationId_clientMessageId_key" ON "messages"("conversationId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_code_key" ON "tickets"("code");

-- CreateIndex
CREATE INDEX "tickets_requesterId_status_idx" ON "tickets"("requesterId", "status");

-- CreateIndex
CREATE INDEX "tickets_status_slaDueAt_idx" ON "tickets"("status", "slaDueAt");

-- CreateIndex
CREATE INDEX "ticket_events_ticketId_createdAt_idx" ON "ticket_events"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_events_draftId_type_key" ON "ticket_events"("draftId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "help_articles_slug_key" ON "help_articles"("slug");

-- CreateIndex
CREATE INDEX "ticket_drafts_conversationId_status_idx" ON "ticket_drafts"("conversationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_decisions_messageId_key" ON "agent_decisions"("messageId");

-- CreateIndex
CREATE INDEX "agent_decisions_conversationId_createdAt_idx" ON "agent_decisions"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "handoffs_status_createdAt_idx" ON "handoffs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "handoffs_conversationId_idx" ON "handoffs"("conversationId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedAnalystId_fkey" FOREIGN KEY ("assignedAnalystId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_originConversationId_fkey" FOREIGN KEY ("originConversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_drafts" ADD CONSTRAINT "ticket_drafts_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_drafts" ADD CONSTRAINT "ticket_drafts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_assumedById_fkey" FOREIGN KEY ("assumedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

