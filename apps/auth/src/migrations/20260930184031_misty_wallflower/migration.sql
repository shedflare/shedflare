CREATE TABLE `agent_authorizations` (
	`device_code_hash` text PRIMARY KEY,
	`user_code_hash` text NOT NULL,
	`requester_hash` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`days` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`next_poll_at` integer NOT NULL,
	`interval` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_login_flows` (
	`token_hash` text PRIMARY KEY,
	`user_code` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_authorizations_user_code` ON `agent_authorizations` (`user_code_hash`);--> statement-breakpoint
CREATE INDEX `agent_authorizations_expiry` ON `agent_authorizations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `agent_authorizations_requester` ON `agent_authorizations` (`requester_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_login_flows_expiry` ON `agent_login_flows` (`expires_at`);