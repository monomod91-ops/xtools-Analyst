CREATE TABLE "artworks" (
	"id" serial PRIMARY KEY,
	"seller_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price" integer NOT NULL,
	"is_ai" boolean DEFAULT false NOT NULL,
	"is_video" boolean DEFAULT false NOT NULL,
	"blob_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inquiries" (
	"id" serial PRIMARY KEY,
	"user_id" text,
	"email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"reply" text,
	"replied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY,
	"artwork_id" integer NOT NULL,
	"buyer_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"price" integer NOT NULL,
	"tip" integer DEFAULT 0 NOT NULL,
	"fee" integer NOT NULL,
	"net" integer NOT NULL,
	"stripe_session_id" text NOT NULL UNIQUE,
	"stripe_payment_intent_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"download_token" text NOT NULL UNIQUE,
	"buyer_email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"paid_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"stripe_account_id" text,
	"stripe_charges_enabled" boolean DEFAULT false NOT NULL,
	"stripe_payouts_enabled" boolean DEFAULT false NOT NULL,
	"stripe_details_submitted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY,
	"order_id" integer NOT NULL UNIQUE,
	"artwork_id" integer NOT NULL,
	"seller_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"stars" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artworks_seller_idx" ON "artworks" ("seller_id");--> statement-breakpoint
CREATE INDEX "artworks_status_idx" ON "artworks" ("status");--> statement-breakpoint
CREATE INDEX "orders_buyer_idx" ON "orders" ("buyer_id");--> statement-breakpoint
CREATE INDEX "orders_seller_idx" ON "orders" ("seller_id");--> statement-breakpoint
CREATE INDEX "orders_artwork_idx" ON "orders" ("artwork_id");--> statement-breakpoint
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_seller_id_profiles_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_artwork_id_artworks_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_profiles_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_id_profiles_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_artwork_id_artworks_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_seller_id_profiles_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_buyer_id_profiles_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "profiles"("id");