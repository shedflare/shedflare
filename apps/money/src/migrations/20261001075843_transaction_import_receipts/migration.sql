CREATE TABLE `transaction_imports` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`rows` text NOT NULL,
	`skipped` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_transaction_imports_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE
);
