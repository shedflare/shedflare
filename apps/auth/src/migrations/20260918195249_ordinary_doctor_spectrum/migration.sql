CREATE TABLE `app_sessions` (
	`token_hash` text PRIMARY KEY,
	`login_id` text NOT NULL,
	`client_id` text NOT NULL,
	`origin` text NOT NULL,
	CONSTRAINT `fk_app_sessions_login_id_login_sessions_token_hash_fk` FOREIGN KEY (`login_id`) REFERENCES `login_sessions`(`token_hash`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `handoffs` (
	`code_hash` text PRIMARY KEY,
	`login_id` text NOT NULL,
	`client_id` text NOT NULL,
	`origin` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_handoffs_login_id_login_sessions_token_hash_fk` FOREIGN KEY (`login_id`) REFERENCES `login_sessions`(`token_hash`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `login_flows` (
	`token_hash` text PRIMARY KEY,
	`client_id` text NOT NULL,
	`origin` text NOT NULL,
	`app_state` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_sessions` (
	`token_hash` text PRIMARY KEY,
	`email` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_sessions_login` ON `app_sessions` (`login_id`);--> statement-breakpoint
CREATE INDEX `handoffs_login` ON `handoffs` (`login_id`);--> statement-breakpoint
CREATE INDEX `handoffs_expiry` ON `handoffs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `login_flows_expiry` ON `login_flows` (`expires_at`);--> statement-breakpoint
CREATE INDEX `login_sessions_expiry` ON `login_sessions` (`expires_at`);