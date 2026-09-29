import { resolveWinePhoto, type InventoryPrincipal, type InventoryTransaction } from "./inventoryServer";

const receiptId = "37b70668-e6ce-4bba-a152-64d7b7f30b4d";
const principal: InventoryPrincipal = { role: "guest", guestLinkId: "guest-link-a" };

function photoReader(rows: Array<{ id: string; actorKey: string; status: string; photoPath: string }>) {
  const selectFrom = jasmine.createSpy("selectFrom").and.callFake(() => {
    const filters: Record<string, unknown> = {};
    const query = {
      select: () => query,
      where: (column: string, _operator: string, value: unknown) => {
        filters[column] = value;
        return query;
      },
      executeTakeFirst: async () => rows.find((row) =>
        row.id === filters.id && row.actorKey === filters.actorKey && row.status === filters.status,
      ),
    };
    return query;
  });
  return { reader: { selectFrom } as unknown as InventoryTransaction, selectFrom };
}

describe("ready photo receipt access", () => {
  it("accepts a ready receipt owned by current actor", async () => {
    const { reader } = photoReader([{
      id: receiptId,
      actorKey: "guest:guest-link-a",
      status: "ready",
      photoPath: "/_cdn/static/photo.png",
    }]);
    await expectAsync(resolveWinePhoto(reader, principal, receiptId, null))
      .toBeResolvedTo("/_cdn/static/photo.png");
  });

  it("rejects pending or another actor's receipt", async () => {
    const pending = photoReader([{
      id: receiptId,
      actorKey: "guest:guest-link-a",
      status: "pending",
      photoPath: "/_cdn/static/pending.png",
    }]).reader;
    const foreign = photoReader([{
      id: receiptId,
      actorKey: "guest:guest-link-b",
      status: "ready",
      photoPath: "/_cdn/static/foreign.png",
    }]).reader;
    await expectAsync(resolveWinePhoto(pending, principal, receiptId, null)).toBeRejected();
    await expectAsync(resolveWinePhoto(foreign, principal, receiptId, null)).toBeRejected();
  });

  it("preserves omitted photos and clears explicit null without a database read", async () => {
    const { reader, selectFrom } = photoReader([]);
    await expectAsync(resolveWinePhoto(reader, principal, undefined, "/_cdn/static/current.png"))
      .toBeResolvedTo("/_cdn/static/current.png");
    await expectAsync(resolveWinePhoto(reader, principal, null, "/_cdn/static/current.png"))
      .toBeResolvedTo(null);
    expect(selectFrom).not.toHaveBeenCalled();
  });
});
