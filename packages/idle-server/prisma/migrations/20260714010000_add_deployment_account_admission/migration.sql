CREATE TABLE "DeploymentAccountBudget" (
    "id" TEXT NOT NULL,
    "admittedAccounts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentAccountBudget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeploymentAccountBudget_admittedAccounts_check"
        CHECK ("admittedAccounts" >= 0)
);

INSERT INTO "DeploymentAccountBudget" ("id", "admittedAccounts", "updatedAt")
SELECT 'accounts', count(*)::integer, CURRENT_TIMESTAMP
FROM "Account";
