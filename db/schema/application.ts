import { sql } from "drizzle-orm";
import {
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  EducationEntry,
  ProfileLink,
  WorkHistoryEntry,
} from "@/lib/candidate-profile";

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  kernelProfileId: text("kernel_profile_id").notNull().default(""),
});

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.userId],
      name: "workspace_memberships_pkey",
    }),
    foreignKey({
      name: "workspace_memberships_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check("workspace_memberships_role_check", sql`${table.role} = 'owner'`),
  ]
);

export const vaultItems = pgTable(
  "vault_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    account: text("account").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "vault_items_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "vault_items_kind_check",
      sql`${table.kind} IN ('login', 'payment', 'address', 'contact', 'phone', 'identity', 'token')`
    ),
    index("vault_items_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt.desc().nullsFirst()
    ),
  ]
);

export const settings = pgTable(
  "settings",
  {
    workspaceId: text("workspace_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.key],
      name: "settings_pkey",
    }),
    foreignKey({
      name: "settings_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "settings_key_check",
      sql`${table.key} IN ('gateway_model', 'self_identification')`
    ),
  ]
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "agent_sessions_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    index("agent_sessions_workspace_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const browserSessions = pgTable(
  "browser_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "browser_sessions_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    index("browser_sessions_workspace_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const browserRunCheckpoints = pgTable(
  "browser_run_checkpoints",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sessionId: text("session_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: text("created_at").notNull(),
    phase: text("phase").notNull(),
    state: text("state"),
    action: text("action"),
    attempt: integer("attempt").notNull().default(0),
    page: text("page"),
    errorCode: text("error_code"),
    actions: jsonb("actions").$type<string[]>().notNull().default([]),
    trace: jsonb("trace").$type<string[]>().notNull().default([]),
  },
  (table) => [
    foreignKey({
      name: "browser_run_checkpoints_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    index("browser_run_checkpoints_session_created_idx").on(
      table.sessionId,
      table.createdAt.desc().nullsFirst()
    ),
    index("browser_run_checkpoints_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const applicationSubmissionScreenshots = pgTable(
  "application_submission_screenshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sessionId: text("session_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: text("created_at").notNull(),
    page: text("page"),
    kind: text("kind").notNull().default("submitted"),
    // The role and posting this image belongs to, so a thread with two
    // applications in flight can caption each batch by name rather than
    // numbering both into one ambiguous run. Empty for rows written before
    // migration 0017, which is why the caption has a fallback.
    role: text("role").notNull().default(""),
    applyUrl: text("apply_url").notNull().default(""),
    mimeType: text("mime_type").notNull().default("image/png"),
    pngBase64: text("png_base64").notNull(),
    deliveredAt: text("delivered_at"),
  },
  (table) => [
    foreignKey({
      name: "application_submission_screenshots_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    index("application_submission_screenshots_workspace_pending_idx").on(
      table.workspaceId,
      table.deliveredAt,
      table.createdAt.desc().nullsFirst()
    ),
    check(
      "application_submission_screenshots_kind_check",
      sql`${table.kind} IN ('review', 'submitted')`
    ),
  ]
);

export const chats = pgTable(
  "chats",
  {
    sessionId: text("session_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd"),
  },
  (table) => [
    foreignKey({
      name: "chats_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check("chats_input_tokens_check", sql`${table.inputTokens} >= 0`),
    check("chats_output_tokens_check", sql`${table.outputTokens} >= 0`),
    check(
      "chats_cost_usd_check",
      sql`${table.costUsd} IS NULL OR ${table.costUsd} >= 0`
    ),
    index("chats_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt.desc().nullsFirst()
    ),
  ]
);

export const encryptedSecrets = pgTable(
  "encrypted_secrets",
  {
    workspaceId: text("workspace_id").notNull(),
    namespace: text("namespace").notNull(),
    id: text("id").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.namespace, table.id],
      name: "encrypted_secrets_pkey",
    }),
    foreignKey({
      name: "encrypted_secrets_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "encrypted_secrets_namespace_check",
      sql`${table.namespace} = 'vault'`
    ),
  ]
);

/**
 * Candidate-authored ATS profile. Deliberately excludes SSN, date of birth,
 * government IDs, references, passwords, and EEO answers (those stay on
 * settings.self_identification).
 */
export const candidateProfiles = pgTable(
  "candidate_profiles",
  {
    workspaceId: text("workspace_id").primaryKey(),
    legalFirstName: text("legal_first_name").notNull().default(""),
    legalLastName: text("legal_last_name").notNull().default(""),
    preferredName: text("preferred_name").notNull().default(""),
    locationCity: text("location_city").notNull().default(""),
    locationRegion: text("location_region").notNull().default(""),
    locationPostalCode: text("location_postal_code").notNull().default(""),
    locationCountryCode: text("location_country_code").notNull().default(""),
    workAuthorization: text("work_authorization").notNull().default(""),
    requiresSponsorshipNow: text("requires_sponsorship_now")
      .notNull()
      .default(""),
    requiresSponsorshipFuture: text("requires_sponsorship_future")
      .notNull()
      .default(""),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    salaryCurrency: text("salary_currency").notNull().default("USD"),
    salaryPeriod: text("salary_period").notNull().default(""),
    earliestStartDate: text("earliest_start_date").notNull().default(""),
    willingToRelocate: text("willing_to_relocate").notNull().default(""),
    workArrangement: text("work_arrangement").notNull().default(""),
    headline: text("headline").notNull().default(""),
    summary: text("summary").notNull().default(""),
    yearsExperience: integer("years_experience"),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    links: jsonb("links").$type<ProfileLink[]>().notNull().default([]),
    workHistory: jsonb("work_history")
      .$type<WorkHistoryEntry[]>()
      .notNull()
      .default([]),
    education: jsonb("education")
      .$type<EducationEntry[]>()
      .notNull()
      .default([]),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "candidate_profiles_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "candidate_profiles_work_authorization_check",
      sql`${table.workAuthorization} IN ('', 'us_citizen', 'us_permanent_resident', 'us_visa_no_sponsorship', 'requires_sponsorship', 'other')`
    ),
    check(
      "candidate_profiles_requires_sponsorship_now_check",
      sql`${table.requiresSponsorshipNow} IN ('', 'yes', 'no')`
    ),
    check(
      "candidate_profiles_requires_sponsorship_future_check",
      sql`${table.requiresSponsorshipFuture} IN ('', 'yes', 'no')`
    ),
    check(
      "candidate_profiles_salary_period_check",
      sql`${table.salaryPeriod} IN ('', 'year', 'hour')`
    ),
    check(
      "candidate_profiles_willing_to_relocate_check",
      sql`${table.willingToRelocate} IN ('', 'yes', 'no')`
    ),
    check(
      "candidate_profiles_work_arrangement_check",
      sql`${table.workArrangement} IN ('', 'remote', 'hybrid', 'onsite', 'flexible')`
    ),
  ]
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Candidate-owned files (resume, cover letter, transcripts). Bytes stay in
 * this workspace table so applications do not depend on JuiceBox storage.
 */
export const candidateDocuments = pgTable(
  "candidate_documents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    isDefault: text("is_default").notNull().default(""),
    extractedText: text("extracted_text").notNull().default(""),
    bytes: bytea("bytes").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "candidate_documents_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "candidate_documents_kind_check",
      sql`${table.kind} IN ('resume', 'cover_letter', 'transcript', 'other')`
    ),
    check(
      "candidate_documents_source_check",
      sql`${table.source} IN ('upload', 'gmail', 'linq', 'goforay')`
    ),
    check(
      "candidate_documents_is_default_check",
      sql`${table.isDefault} IN ('', 'yes')`
    ),
    check(
      "candidate_documents_byte_size_check",
      sql`${table.byteSize} > 0 AND ${table.byteSize} <= 8388608`
    ),
    uniqueIndex("candidate_documents_workspace_default_resume_idx")
      .on(table.workspaceId)
      .where(sql`${table.kind} = 'resume' AND ${table.isDefault} = 'yes'`),
    index("candidate_documents_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt.desc().nullsFirst()
    ),
  ]
);

/**
 * Free-form durable facts the model saved so later chats do not re-ask.
 * Structured ATS fields stay on candidate_profiles.
 */
export const workspaceMemories = pgTable(
  "workspace_memories",
  {
    workspaceId: text("workspace_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.key],
      name: "workspace_memories_pkey",
    }),
    foreignKey({
      name: "workspace_memories_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
  ]
);
