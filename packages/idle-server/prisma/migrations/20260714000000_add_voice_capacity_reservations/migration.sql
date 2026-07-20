CREATE TABLE "VoiceCapacityReservation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "reservedSeconds" INTEGER NOT NULL,
    "providerConversationId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceCapacityReservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VoiceCapacityReservation_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VoiceCapacityReservation_requestId_check"
        CHECK (char_length("requestId") BETWEEN 1 AND 64),
    CONSTRAINT "VoiceCapacityReservation_reservedSeconds_check"
        CHECK ("reservedSeconds" BETWEEN 1 AND 3600),
    CONSTRAINT "VoiceCapacityReservation_providerConversationId_check"
        CHECK (
            "providerConversationId" IS NULL
            OR char_length("providerConversationId") BETWEEN 1 AND 64
        ),
    CONSTRAINT "VoiceCapacityReservation_expiresAt_check"
        CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "VoiceCapacityReservation_providerConversationId_key"
    ON "VoiceCapacityReservation"("providerConversationId");
CREATE UNIQUE INDEX "VoiceCapacityReservation_accountId_requestId_key"
    ON "VoiceCapacityReservation"("accountId", "requestId");
CREATE INDEX "VoiceCapacityReservation_accountId_expiresAt_idx"
    ON "VoiceCapacityReservation"("accountId", "expiresAt");
