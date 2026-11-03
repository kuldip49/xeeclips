import type { Prisma } from "@prisma/client";
import { requestIdentity } from "./request-context";

/** A receipt commits with the canonical business transaction, closing the retry/crash gap. */
export async function checkpointOperation(
  tx: Prisma.TransactionClient,
  result: Prisma.InputJsonObject,
  entityId: string,
) {
  const identity = requestIdentity.getStore();
  if (!identity?.operationId || !identity.userId) return;
  await tx.mcpAction.updateMany({
    where: {
      id: identity.operationId,
      userId: identity.userId,
      status: "PENDING",
    },
    data: { status: "COMPLETE", result, entityId, completedAt: new Date() },
  });
}
