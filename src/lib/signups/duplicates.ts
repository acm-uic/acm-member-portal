import { sql } from "drizzle-orm";

/** Include matching signups outside the current page and existing member accounts. */
export const duplicateSignupNetid = sql<boolean>`
  EXISTS (
    SELECT 1 FROM signup_submissions AS other_signup
    WHERE other_signup.netid = "signup_submissions"."netid"
      AND other_signup.id <> "signup_submissions"."id"
      AND other_signup.status IN ('pending', 'approved')
  ) OR EXISTS (
    SELECT 1 FROM "user" AS existing_member
    WHERE existing_member.netid = "signup_submissions"."netid"
  )
`;
