CREATE UNIQUE INDEX "feishu_login_codes_flow_seq_uidx" ON "feishu_login_codes" USING btree ("flow_hash","flow_seq");--> statement-breakpoint
CREATE INDEX "feishu_login_codes_email_created_at_idx" ON "feishu_login_codes" USING btree ("email_hmac","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_login_codes_email_seq_uidx" ON "feishu_login_codes" USING btree ("email_hmac","email_seq");--> statement-breakpoint
CREATE INDEX "feishu_login_codes_created_at_idx" ON "feishu_login_codes" USING btree ("created_at");