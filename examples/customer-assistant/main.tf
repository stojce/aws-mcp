# Tool schemas, hand-derived from the verified `proxy` GraphQL operations
# (ticket 10). JSON-Schema per tool, passed as JSON-encoded strings.
#
# `getMyBookedEvents(startTime?: DateTime) → [BookingEvent]`
# `getMyMemberships(all?: Boolean) → [UserMembership]`

provider "aws" {
  default_tags {
    tags = {
      Project = "MCP-DEMO"
    }
  }
}

locals {
  # Recruter-native reads (functions/gateway_tools.py in the recruter repo
  # implements the same names; per-user scoping comes from verified claims).

  get_my_jobs_input = jsonencode({
    type       = "object"
    properties = {}
    required   = []
  })

  get_my_jobs_output = jsonencode({
    type = "object"
    properties = {
      jobs = {
        type        = "array"
        description = "Jobs known to the system with processing status."
        items = {
          type = "object"
          properties_json = jsonencode({
            id               = { type = "string", description = "Job id" }
            company          = { type = "string", description = "Company name" }
            title            = { type = "string", description = "Job title" }
            language         = { type = "string", description = "Language" }
            processingStatus = { type = "string", description = "AI processing status" }
            createdAt        = { type = "string", description = "Creation timestamp" }
            hasAiResults     = { type = "boolean", description = "Whether AI analysis is ready" }
          })
        }
      }
    }
    required = ["jobs"]
  })

  get_job_details_input = jsonencode({
    type = "object"
    properties = {
      jobId = { type = "string", description = "Job id (required)" }
    }
    required = ["jobId"]
  })

  get_job_details_output = jsonencode({
    type = "object"
    properties = {
      id               = { type = "string", description = "Job id" }
      company          = { type = "string", description = "Company name" }
      title            = { type = "string", description = "Job title" }
      description      = { type = "string", description = "Job description" }
      language         = { type = "string", description = "Language" }
      processingStatus = { type = "string", description = "AI processing status" }
      createdAt        = { type = "string", description = "Creation timestamp" }
      createdBy        = { type = "string", description = "Creator username" }
      aiSummary        = { type = "string", description = "AI summary when ready" }
      candidates = {
        type        = "array"
        description = "Candidate summaries for the job."
        items = {
          type = "object"
          properties_json = jsonencode({
            id               = { type = "string", description = "Candidate id" }
            email            = { type = "string", description = "Candidate email" }
            fullName         = { type = "string", description = "Candidate name" }
            processingStatus = { type = "string", description = "Matching status" }
            matchScore       = { type = "number", description = "Match score when ready" }
            createdAt        = { type = "string", description = "Creation timestamp" }
            processedAt      = { type = "string", description = "Processing timestamp" }
          })
        }
      }
    }
    required = ["id", "title"]
  })

  get_job_candidates_input = jsonencode({
    type = "object"
    properties = {
      jobId = { type = "string", description = "Job id (required)" }
    }
    required = ["jobId"]
  })

  get_job_candidates_output = jsonencode({
    type = "object"
    properties = {
      jobId = { type = "string", description = "Job id" }
      candidates = {
        type        = "array"
        description = "Candidates matched to the job."
        items = {
          type = "object"
          properties_json = jsonencode({
            id               = { type = "string", description = "Candidate id" }
            email            = { type = "string", description = "Candidate email" }
            fullName         = { type = "string", description = "Candidate name" }
            processingStatus = { type = "string", description = "Matching status" }
            matchScore       = { type = "number", description = "Match score when ready" }
            createdAt        = { type = "string", description = "Creation timestamp" }
            processedAt      = { type = "string", description = "Processing timestamp" }
          })
        }
      }
    }
    required = ["jobId", "candidates"]
  })

  verified_targets = [
    {
      name             = "get-my-jobs"
      description      = "All jobs known to the system (read-only; MVP parity with GET /jobs)."
      lambda_arn       = var.gateway_lambda_target_arn
      tool_name        = "get_my_jobs"
      tool_description = "List jobs with id, company, title, processing status and AI-analysis availability."
      input_schema     = local.get_my_jobs_input
      output_schema    = local.get_my_jobs_output
    },
    {
      name             = "get-job-details"
      description      = "Job details including AI summary and candidate summaries (read-only)."
      lambda_arn       = var.gateway_lambda_target_arn
      tool_name        = "get_job_details"
      tool_description = "Get one job's details (company, title, description, processing status, AI summary) with summarized candidates. Requires jobId."
      input_schema     = local.get_job_details_input
      output_schema    = local.get_job_details_output
    },
    {
      name             = "get-job-candidates"
      description      = "Candidates matched to a job, with match scores (read-only)."
      lambda_arn       = var.gateway_lambda_target_arn
      tool_name        = "get_job_candidates"
      tool_description = "List candidates matched to a job (name, email, match score, processing status). Requires jobId."
      input_schema     = local.get_job_candidates_input
      output_schema    = local.get_job_candidates_output
    },
  ]
}

module "mcp" {
  source       = "../../modules/mcp-gateway"
  name         = var.name
  region       = var.region
  user_pool_id = var.user_pool_id

  # The existing Apollo graphql.ts Lambda (unchanged target, per ADR-0001).
  gateway_lambda_target_arn = var.gateway_lambda_target_arn

  web_client_callback_url = var.mcp_client_callback_url
  web_client_logout_url   = var.mcp_client_logout_url

  targets = local.verified_targets
}

output "gateway_url" {
  value = module.mcp.gateway_url
}

# Used by tests/*: the MCP app client id whose tokens the gateway accepts.
output "mcp_app_client_id" {
  value = module.mcp.mcp_app_client_id
}

# Required follow-up in guryou-infra-terraform (owns the graphql Lambda env):
# set MCP_CLAIMS_SIGNING_SECRET on that Lambda from this SSM parameter, or the
# target denies every gateway call (fail closed). See the runbook.
output "mcp_claims_signing_secret_ssm_name" {
  value = module.mcp.mcp_claims_signing_secret_ssm_name
}
