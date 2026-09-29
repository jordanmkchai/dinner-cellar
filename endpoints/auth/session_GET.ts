import {
  setServerSession,
  NotAuthenticatedError,
} from "../../helpers/getSetServerSession";
import { User } from "../../helpers/User";
import { getServerUserSession } from "../../helpers/getServerUserSession";
import superjson from "superjson";
import { db } from "../../helpers/db";
import { cellarAccess } from "../../helpers/cellarAccess";

export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    if (!(await cellarAccess.isDesignatedHostUser(user.id))) {
      await db.deleteFrom("sessions").where("id", "=", session.id).execute();
      const response = new Response(superjson.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
      return response;
    }

    // Create response with user data
    const response = new Response(
      superjson.stringify({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          role: user.role,
        } satisfies User,
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // Update the session cookie with the new lastAccessed time
    await setServerSession(response, {
      id: session.id,
      createdAt: session.createdAt,
      lastAccessed: session.lastAccessed.getTime(),
    });

    return response;
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return new Response(
        superjson.stringify({ error: "Not authenticated" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
    console.error("Session validation error:", error);
    return new Response(
      superjson.stringify({ error: "Session validation failed" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}

