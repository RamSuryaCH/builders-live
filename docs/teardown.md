# Teardown

Run this from the repository root in AWS CloudShell, in ap-southeast-2:

```bash
bash deploy/cloudshell-destroy.sh
```

The script empties the frontend bucket, then deletes the stack. CloudFront distributions often take several minutes to delete. Wait until the stack is gone before you start another deploy with the same name.

The delete also removes:

- The WebSocket API and the Lambda functions
- The on-demand DynamoDB table
- The SQS timer queue
- The CloudFront distribution and the private S3 bucket
- The SSM SecureString parameters that hold the host PIN hash and the signing key
- The 5 USD monthly budget

If a delete is interrupted, room items still expire. Every item is written with a DynamoDB TTL (24 hours by default, `DataTtlHours` at deploy). TTL deletes are not instant, but nothing is left provisioned.

There is no NAT gateway and no provisioned capacity to clean up separately.

Confirm the budget email subscription in the AWS Budgets console if a confirmation mail is still outstanding. Deleting the budget stops further alerts.

Do not put account IDs or the host PIN into tickets about a failed teardown. The stack name defaults to `builders-live`.
