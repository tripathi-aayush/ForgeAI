-- CreateEnum
CREATE TYPE "SkillType" AS ENUM ('BUGFIX');

-- CreateEnum
CREATE TYPE "SkillRunStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "skill_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "skillType" "SkillType" NOT NULL DEFAULT 'BUGFIX',
    "input" TEXT NOT NULL,
    "proposedDiff" JSONB,
    "status" "SkillRunStatus" NOT NULL DEFAULT 'PROPOSED',
    "prUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_runs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
