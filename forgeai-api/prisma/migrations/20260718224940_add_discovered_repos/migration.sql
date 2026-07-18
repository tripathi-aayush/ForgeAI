-- CreateTable
CREATE TABLE "discovered_repos" (
    "id" TEXT NOT NULL,
    "githubUrl" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "openIssues" INTEGER NOT NULL DEFAULT 0,
    "lastPushedAt" TIMESTAMP(3) NOT NULL,
    "domainTags" TEXT[],
    "techTags" TEXT[],
    "architectureTags" TEXT[],
    "healthScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "embedding" vector(1536),
    "embeddingProvider" TEXT NOT NULL DEFAULT 'GEMINI',
    "readmeSummary" TEXT,
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovered_repos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "discovered_repos_githubUrl_key" ON "discovered_repos"("githubUrl");
