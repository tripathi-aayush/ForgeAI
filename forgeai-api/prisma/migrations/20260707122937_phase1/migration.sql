-- CreateEnum
CREATE TYPE "IndexingStatus" AS ENUM ('PENDING', 'INDEXING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "indexingStatus" "IndexingStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "lastIndexedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "code_chunks" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_chunks_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
