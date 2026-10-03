CREATE INDEX "availability_slot_practitioner_profile_id_idx" ON "availability_slot" USING btree ("practitioner_profile_id");--> statement-breakpoint
CREATE INDEX "caregiver_link_caregiver_user_id_idx" ON "caregiver_link" USING btree ("caregiver_user_id");--> statement-breakpoint
CREATE INDEX "caregiver_link_managed_dependent_id_idx" ON "caregiver_link" USING btree ("managed_dependent_id");--> statement-breakpoint
CREATE INDEX "caregiver_link_subject_user_id_idx" ON "caregiver_link" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "consent_audit_link_id_idx" ON "consent_audit" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "verification_review_practitioner_profile_id_idx" ON "verification_review" USING btree ("practitioner_profile_id");--> statement-breakpoint
CREATE INDEX "verification_review_reviewer_user_id_idx" ON "verification_review" USING btree ("reviewer_user_id");