import {
  assertVersion,
  quantity,
  stockTotal,
  PolicyError,
} from "./inventoryPolicy";

type CorrectionInput = {
  currentQuantity: number;
  actualVersion: string;
  expectedVersion: string;
  quantity: number;
};

export type StockCorrectionPlan = {
  delta: number;
  nextQuantity: number;
  changed: boolean;
};

export function planStockCorrection(input: CorrectionInput): StockCorrectionPlan {
  assertVersion(input.actualVersion, input.expectedVersion);
  const currentQuantity = quantity(input.currentQuantity, true);
  const nextQuantity = quantity(input.quantity, true);
  return {
    delta: nextQuantity - currentQuantity,
    nextQuantity,
    changed: nextQuantity !== currentQuantity,
  };
}

type MoveInput = {
  sourceLocationId: string;
  targetLocationId: string;
  actualVersion: string;
  expectedVersion: string;
  sourceQuantity: number;
  targetQuantity: number;
  quantity: number;
};

export type StockMovePlan = {
  sourceAfter: number;
  targetAfter: number;
  moved: number;
  totalBefore: number;
  totalAfter: number;
};

export function planStockMove(input: MoveInput): StockMovePlan {
  assertVersion(input.actualVersion, input.expectedVersion);
  if (input.sourceLocationId === input.targetLocationId) {
    throw policyError("Choose a different destination", "SAME_LOCATION");
  }

  const sourceQuantity = quantity(input.sourceQuantity, true);
  const targetQuantity = quantity(input.targetQuantity, true);
  const moved = quantity(input.quantity);
  if (moved > sourceQuantity) {
    throw policyError("Not enough bottles at the source location", "INSUFFICIENT_STOCK");
  }

  const sourceAfter = stockTotal(sourceQuantity, -moved);
  const targetAfter = stockTotal(targetQuantity, moved);
  // Totals can exceed one row's PostgreSQL integer limit while each row stays valid.
  const totalBefore = sourceQuantity + targetQuantity;
  const totalAfter = sourceAfter + targetAfter;
  if (totalAfter !== totalBefore) {
    throw policyError("Bottle total changed during move", "STOCK_CONSERVATION_FAILED");
  }
  return { sourceAfter, targetAfter, moved, totalBefore, totalAfter };
}

export type ContactDesignationInput = {
  requestedIsHost: boolean;
  requestedActive: boolean;
  currentContactId: string | null;
  currentContactIsHost: boolean;
  currentHostId: string | null;
};

export type ContactDesignationPlan = { demoteHostId: string | null };

export function planContactDesignation(input: ContactDesignationInput): ContactDesignationPlan {
  if (input.requestedIsHost && !input.requestedActive) {
    throw policyError("The designated host contact must be active", "HOST_CONTACT_MUST_BE_ACTIVE");
  }
  if (
    input.currentContactIsHost &&
    input.currentContactId !== null &&
    input.currentContactId === input.currentHostId &&
    !input.requestedIsHost
  ) {
    throw policyError("Promote another active contact before removing the current host", "ACTIVE_HOST_REQUIRED");
  }

  const demoteHostId = input.requestedIsHost && input.currentHostId !== input.currentContactId
    ? input.currentHostId
    : null;
  return { demoteHostId };
}

export function parseHostBody<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new PolicyError("Invalid request body", 400, "INVALID_INPUT");
  }
}

function policyError(message: string, code: string): PolicyError {
  return new PolicyError(message, 409, code);
}
