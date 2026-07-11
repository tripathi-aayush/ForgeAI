-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('NOT_STARTED', 'QUEUED', 'RUNNING', 'DONE');

-- AlterTable
ALTER TABLE "skill_runs" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "executionResult" JSONB,
ADD COLUMN     "executionStatus" "ExecutionStatus" NOT NULL DEFAULT 'NOT_STARTED';
