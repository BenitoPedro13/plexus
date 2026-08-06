CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'PARTIAL', 'COMPLETE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."job_step_status" AS ENUM('PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"processor" text NOT NULL,
	"params" jsonb NOT NULL,
	"order" integer NOT NULL,
	"status" "job_step_status" DEFAULT 'PENDING' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"input_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE no action ON UPDATE no action;