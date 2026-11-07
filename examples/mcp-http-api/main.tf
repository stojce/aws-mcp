terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.69.1, < 7.0.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project = "mcp-http-api-example"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name = var.name

  test_users = var.test_users

  cognito_authorization_endpoint = "https://${aws_cognito_user_pool_domain.example.domain}.auth.${var.region}.amazoncognito.com/oauth2/authorize"
  cognito_token_endpoint         = "https://${aws_cognito_user_pool_domain.example.domain}.auth.${var.region}.amazoncognito.com/oauth2/token"
  # Cognito supports S256 but omits it from its discovery document. Publish our
  # OAuth metadata for the same public endpoints by default.
  oauth_endpoints = var.oauth_proxy_endpoints == null ? {
    authorization_endpoint = local.cognito_authorization_endpoint
    token_endpoint         = local.cognito_token_endpoint
  } : var.oauth_proxy_endpoints
}

# ── Example-only identity: a user pool that stands in for the app's pool ──────

resource "aws_cognito_user_pool" "example" {
  name                     = "${local.name}-pool"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]
  user_pool_tier           = "ESSENTIALS"

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }
}

resource "aws_cognito_user_pool_domain" "example" {
  domain                = "${local.name}-${data.aws_caller_identity.current.account_id}"
  user_pool_id          = aws_cognito_user_pool.example.id
  managed_login_version = 2
}

# Resource-bound OAuth tokens require managed login. API-created domains also
# need an explicit branding style for each app client before login is available.
resource "aws_cognito_managed_login_branding" "mcp" {
  user_pool_id = aws_cognito_user_pool.example.id
  client_id    = module.cognito.client_id
  # use_cognito_provided_values = false

  # FAVICON_ICO | FAVICON_SVG | EMAIL_GRAPHIC | SMS_GRAPHIC | AUTH_APP_GRAPHIC | PASSWORD_GRAPHIC | PASSKEY_GRAPHIC | PAGE_HEADER_LOGO | PAGE_HEADER_BACKGROUND | PAGE_FOOTER_LOGO | PAGE_FOOTER_BACKGROUND | PAGE_BACKGROUND | FORM_BACKGROUND | FORM_LOGO | IDP_BUTTON_ICON
  asset {
    bytes      = filebase64("logo.svg")
    category   = "FORM_LOGO"
    color_mode = "DYNAMIC"
    extension  = "SVG"
  }

  asset {
    bytes      = filebase64("logo.svg")
    category   = "FORM_LOGO"
    color_mode = "LIGHT"
    extension  = "SVG"
  }


  settings = jsonencode(
    {
      categories = {
        auth = {
          authMethodOrder = [
            [
              {
                display = "BUTTON"
                type    = "FEDERATED"
              },
              {
                display = "INPUT"
                type    = "USERNAME_PASSWORD"
              },
            ],
          ]
          federation = {
            interfaceStyle = "BUTTON_LIST"
            order          = []
          }
        }
        form = {
          displayGraphics = true
          instructions = {
            enabled = false
          }
          languageSelector = {
            enabled = false
          }
          location = {
            horizontal = "CENTER"
            vertical   = "CENTER"
          }
          sessionTimerDisplay = "NONE"
        }
        global = {
          colorSchemeMode = "LIGHT"
          pageFooter = {
            enabled = false
          }
          pageHeader = {
            enabled = false
          }
          spacingDensity = "REGULAR"
        }
        signUp = {
          acceptanceElements = [
            {
              enforcement = "NONE"
              textKey     = "en"
            },
          ]
        }
      }
      componentClasses = {
        buttons = {
          borderRadius = 8
        }
        divider = {
          darkMode = {
            borderColor = "232b37ff"
          }
          lightMode = {
            borderColor = "ebebf0ff"
          }
        }
        dropDown = {
          borderRadius = 8
          darkMode = {
            defaults = {
              itemBackgroundColor = "192534ff"
            }
            hover = {
              itemBackgroundColor = "081120ff"
              itemBorderColor     = "5f6b7aff"
              itemTextColor       = "e9ebedff"
            }
            match = {
              itemBackgroundColor = "d1d5dbff"
              itemTextColor       = "89bdeeff"
            }
          }
          lightMode = {
            defaults = {
              itemBackgroundColor = "ffffffff"
            }
            hover = {
              itemBackgroundColor = "f4f4f4ff"
              itemBorderColor     = "7d8998ff"
              itemTextColor       = "000716ff"
            }
            match = {
              itemBackgroundColor = "414d5cff"
              itemTextColor       = "0972d3ff"
            }
          }
        }
        focusState = {
          darkMode = {
            borderColor = "539fe5ff"
          }
          lightMode = {
            borderColor = "0972d3ff"
          }
        }
        idpButtons = {
          icons = {
            enabled = true
          }
        }
        input = {
          borderRadius = 8
          darkMode = {
            defaults = {
              backgroundColor = "0f1b2aff"
              borderColor     = "5f6b7aff"
            }
            placeholderColor = "8d99a8ff"
          }
          lightMode = {
            defaults = {
              backgroundColor = "ffffffff"
              borderColor     = "7d8998ff"
            }
            placeholderColor = "5f6b7aff"
          }
        }
        inputDescription = {
          darkMode = {
            textColor = "8d99a8ff"
          }
          lightMode = {
            textColor = "5f6b7aff"
          }
        }
        inputLabel = {
          darkMode = {
            textColor = "d1d5dbff"
          }
          lightMode = {
            textColor = "000716ff"
          }
        }
        link = {
          darkMode = {
            defaults = {
              textColor = "539fe5ff"
            }
            hover = {
              textColor = "89bdeeff"
            }
          }
          lightMode = {
            defaults = {
              textColor = "0972d3ff"
            }
            hover = {
              textColor = "033160ff"
            }
          }
        }
        optionControls = {
          darkMode = {
            defaults = {
              backgroundColor = "0f1b2aff"
              borderColor     = "7d8998ff"
            }
            selected = {
              backgroundColor = "539fe5ff"
              foregroundColor = "000716ff"
            }
          }
          lightMode = {
            defaults = {
              backgroundColor = "ffffffff"
              borderColor     = "7d8998ff"
            }
            selected = {
              backgroundColor = "0972d3ff"
              foregroundColor = "ffffffff"
            }
          }
        }
        statusIndicator = {
          darkMode = {
            error = {
              backgroundColor = "1a0000ff"
              borderColor     = "eb6f6fff"
              indicatorColor  = "eb6f6fff"
            }
            pending = {
              indicatorColor = "AAAAAAAA"
            }
            success = {
              backgroundColor = "001a02ff"
              borderColor     = "29ad32ff"
              indicatorColor  = "29ad32ff"
            }
            warning = {
              backgroundColor = "1d1906ff"
              borderColor     = "e0ca57ff"
              indicatorColor  = "e0ca57ff"
            }
          }
          lightMode = {
            error = {
              backgroundColor = "fff7f7ff"
              borderColor     = "d91515ff"
              indicatorColor  = "d91515ff"
            }
            pending = {
              indicatorColor = "AAAAAAAA"
            }
            success = {
              backgroundColor = "f2fcf3ff"
              borderColor     = "037f0cff"
              indicatorColor  = "037f0cff"
            }
            warning = {
              backgroundColor = "fffce9ff"
              borderColor     = "8d6605ff"
              indicatorColor  = "8d6605ff"
            }
          }
        }
      }
      components = {
        alert = {
          borderRadius = 12
          darkMode = {
            error = {
              backgroundColor = "1a0000ff"
              borderColor     = "eb6f6fff"
            }
          }
          lightMode = {
            error = {
              backgroundColor = "fff7f7ff"
              borderColor     = "d91515ff"
            }
          }
        }
        favicon = {
          enabledTypes = [
            "ICO",
            "SVG",
          ]
        }
        form = {
          backgroundImage = {
            enabled = false
          }
          borderRadius = 8
          darkMode = {
            backgroundColor = "0f1b2aff"
            borderColor     = "424650ff"
          }
          lightMode = {
            backgroundColor = "ffffffff"
            borderColor     = "c6c6cdff"
          }
          logo = {
            enabled       = true
            formInclusion = "OUT"
            location      = "CENTER"
            position      = "TOP"
          }
        }
        idpButton = {
          custom = {}
          standard = {
            darkMode = {
              active = {
                backgroundColor = "354150ff"
                borderColor     = "89bdeeff"
                textColor       = "89bdeeff"
              }
              defaults = {
                backgroundColor = "0f1b2aff"
                borderColor     = "c6c6cdff"
                textColor       = "c6c6cdff"
              }
              hover = {
                backgroundColor = "192534ff"
                borderColor     = "89bdeeff"
                textColor       = "89bdeeff"
              }
            }
            lightMode = {
              active = {
                backgroundColor = "d3e7f9ff"
                borderColor     = "033160ff"
                textColor       = "033160ff"
              }
              defaults = {
                backgroundColor = "ffffffff"
                borderColor     = "424650ff"
                textColor       = "424650ff"
              }
              hover = {
                backgroundColor = "f2f8fdff"
                borderColor     = "033160ff"
                textColor       = "033160ff"
              }
            }
          }
        }
        pageBackground = {
          darkMode = {
            color = "0f1b2aff"
          }
          image = {
            enabled = true
          }
          lightMode = {
            color = "ffffffff"
          }
        }
        pageFooter = {
          backgroundImage = {
            enabled = false
          }
          darkMode = {
            background = {
              color = "0f141aff"
            }
            borderColor = "424650ff"
          }
          lightMode = {
            background = {
              color = "fafafaff"
            }
            borderColor = "d5dbdbff"
          }
          logo = {
            enabled  = false
            location = "START"
          }
        }
        pageHeader = {
          backgroundImage = {
            enabled = false
          }
          darkMode = {
            background = {
              color = "0f141aff"
            }
            borderColor = "424650ff"
          }
          lightMode = {
            background = {
              color = "fafafaff"
            }
            borderColor = "d5dbdbff"
          }
          logo = {
            enabled  = false
            location = "START"
          }
        }
        pageText = {
          darkMode = {
            bodyColor        = "b6bec9ff"
            descriptionColor = "b6bec9ff"
            headingColor     = "d1d5dbff"
          }
          lightMode = {
            bodyColor        = "414d5cff"
            descriptionColor = "414d5cff"
            headingColor     = "000716ff"
          }
        }
        phoneNumberSelector = {
          displayType = "TEXT"
        }
        primaryButton = {
          darkMode = {
            active = {
              backgroundColor = "539fe5ff"
              textColor       = "000716ff"
            }
            defaults = {
              backgroundColor = "539fe5ff"
              textColor       = "000716ff"
            }
            disabled = {
              backgroundColor = "ffffffff"
              borderColor     = "ffffffff"
            }
            hover = {
              backgroundColor = "89bdeeff"
              textColor       = "000716ff"
            }
          }
          lightMode = {
            active = {
              backgroundColor = "033160ff"
              textColor       = "ffffffff"
            }
            defaults = {
              backgroundColor = "0972d3ff"
              textColor       = "ffffffff"
            }
            disabled = {
              backgroundColor = "ffffffff"
              borderColor     = "ffffffff"
            }
            hover = {
              backgroundColor = "033160ff"
              textColor       = "ffffffff"
            }
          }
        }
        secondaryButton = {
          darkMode = {
            active = {
              backgroundColor = "354150ff"
              borderColor     = "89bdeeff"
              textColor       = "89bdeeff"
            }
            defaults = {
              backgroundColor = "0f1b2aff"
              borderColor     = "539fe5ff"
              textColor       = "539fe5ff"
            }
            hover = {
              backgroundColor = "192534ff"
              borderColor     = "89bdeeff"
              textColor       = "89bdeeff"
            }
          }
          lightMode = {
            active = {
              backgroundColor = "d3e7f9ff"
              borderColor     = "033160ff"
              textColor       = "033160ff"
            }
            defaults = {
              backgroundColor = "ffffffff"
              borderColor     = "0972d3ff"
              textColor       = "0972d3ff"
            }
            hover = {
              backgroundColor = "f2f8fdff"
              borderColor     = "033160ff"
              textColor       = "033160ff"
            }
          }
        }
      }
    }
  )

  depends_on = [aws_cognito_user_pool_domain.example]
}

# Users are created with a fixed, non-sensitive key set. Passwords are NOT
# managed by Terraform (the AWS provider has no aws_cognito_user_password);
# scripts/set-test-passwords.sh sets them with `admin-set-user-password`.
resource "aws_cognito_user" "test" {
  for_each     = toset(keys(local.test_users))
  user_pool_id = aws_cognito_user_pool.example.id
  username     = local.test_users[each.key].email

  attributes = {
    email          = local.test_users[each.key].email
    email_verified = "true"
  }

  message_action = "SUPPRESS"
}

# ── Demo data: bookings keyed by owner sub ───────────────────────────────────

resource "aws_dynamodb_table" "bookings" {
  name         = "${local.name}-bookings"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table_item" "demo" {
  for_each   = { for b in var.demo_bookings : "${b.owner_sub_key}#${b.id}" => b }
  table_name = aws_dynamodb_table.bookings.name
  hash_key   = aws_dynamodb_table.bookings.hash_key
  range_key  = aws_dynamodb_table.bookings.range_key

  item = jsonencode({
    pk     = { S = "USER#${aws_cognito_user.test[each.value.owner_sub_key].sub}" }
    sk     = { S = "BOOKING#${each.value.id}" }
    status = { S = each.value.status }
    title  = { S = each.value.title }
    when   = { S = each.value.when }
  })
}

# ── Tool backend Lambda (executes tools for the MCP Lambda) ──────────────────

data "archive_file" "tool_backend" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/tool-backend"
  output_path = "${path.module}/.build/tool-backend.zip"
}

resource "aws_iam_role" "tool_backend" {
  name = "${local.name}-tool-backend"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "tool_backend_logs" {
  role       = aws_iam_role.tool_backend.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "tool_backend_read" {
  name = "read-bookings"
  role = aws_iam_role.tool_backend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:Query"]
      Resource = aws_dynamodb_table.bookings.arn
    }]
  })
}

resource "aws_lambda_function" "tool_backend" {
  function_name    = "${local.name}-tool-backend"
  role             = aws_iam_role.tool_backend.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.tool_backend.output_path
  source_code_hash = data.archive_file.tool_backend.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      BOOKINGS_TABLE = aws_dynamodb_table.bookings.name
    }
  }

  depends_on = [aws_iam_role_policy_attachment.tool_backend_logs]
}

# ── Cognito authentication, composed alongside the MCP endpoint ────────────

module "cognito" {
  source = "../../modules/cognito"

  name                           = local.name
  user_pool_id                   = aws_cognito_user_pool.example.id
  mcp_url                        = module.mcp.mcp_url
  callback_urls                  = var.callback_urls
  enable_password_auth_for_tests = var.enable_password_auth_for_tests
}

# ── The module under test ────────────────────────────────────────────────────

module "mcp" {
  source = "../../modules/mcp-http-api"

  name                         = local.name
  cognito_authorization_server = module.cognito.authorization_server
  tool_backend_arn             = aws_lambda_function.tool_backend.arn
  server_name                  = "bookings-mcp"
  server_version               = "1.0.0"

  allowed_origins = var.allowed_origins

  oauth_proxy_endpoints = local.oauth_endpoints

  tools = [
    {
      name        = "get_my_bookings"
      description = "List the signed-in user's bookings. Optionally filter by status."
      input_schema = jsonencode({
        type = "object"
        properties = {
          status = {
            type        = "string"
            enum        = ["confirmed", "cancelled", "past"]
            description = "Filter bookings by status. Omit to return bookings of every status for the signed-in user."
          }
        }
        required             = []
        additionalProperties = false
      })
    },
  ]
}
