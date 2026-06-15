PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`credits` integer DEFAULT 1000 NOT NULL,
	`byoe_url` text,
	`byoe_key` text,
	`byoe_model` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "email", "credits", "byoe_url", "byoe_key", "byoe_model", "created_at") SELECT "id", "username", "email", "credits", "byoe_url", "byoe_key", "byoe_model", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);