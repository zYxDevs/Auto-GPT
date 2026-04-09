-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'PRO', 'BUSINESS', 'ENTERPRISE');

-- AlterEnum
ALTER TYPE "CreditTransactionType" ADD VALUE 'SUBSCRIPTION';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "subscriptionTier" "SubscriptionTier" NOT NULL DEFAULT 'FREE';
