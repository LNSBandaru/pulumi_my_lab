#!/usr/bin/env bash
set -euo pipefail

# ========= CONFIG (edit) =========
REGION="us-east-1"
CLUSTER_ID="ordering-postgres-qa"          # aurora cluster identifier
WRITER_INSTANCE_ID="ordering-postgres-1-qa"      # writer instance id
READER_INSTANCE_ID="ordering-postgres-2-qa"      # a reader you can reboot first

# Names you want for NEW groups (will be created iff missing)
NEW_CLUSTER_PG="aurora-postgres-cdc-enabled-cluster"
NEW_INSTANCE_PG="aurora-postgres-cdc-enabled-instance"

# Replication sizing
MAX_WAL_SENDERS="10"
MAX_REPL_SLOTS="10"

# ========= REQUIREMENTS =========
# aws cli v2 + jq must be installed and authenticated for the target account/region.

aws() { command aws --region "$REGION" "$@"; }

say() { printf "\n👉 %s\n" "$*"; }

# ========= DISCOVERY =========
say "Discover current parameter groups…"
CUR_CLUSTER_PG=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --query "DBClusters[0].DBClusterParameterGroup" \
  --output text)

# discover one member's instance parameter group as template
CUR_INSTANCE_PG=$(aws rds describe-db-instances \
  --query "DBInstances[?DBClusterIdentifier=='$CLUSTER_ID']|[0].DBParameterGroups[0].DBParameterGroupName" \
  --output text)

say "Current groups → cluster: [$CUR_CLUSTER_PG], instance: [$CUR_INSTANCE_PG]"

# ========= CREATE / ENSURE CLUSTER PARAMETER GROUP =========
if ! aws rds describe-db-cluster-parameter-groups \
      --query "DBClusterParameterGroups[?DBClusterParameterGroupName=='$NEW_CLUSTER_PG']" \
      --output json | jq -e 'length>0' >/dev/null; then
  # Need the family of existing cluster PG to clone
  FAMILY=$(aws rds describe-db-cluster-parameter-groups \
    --db-cluster-parameter-group-name "$CUR_CLUSTER_PG" \
    --query "DBClusterParameterGroups[0].DBParameterGroupFamily" \
    --output text)
  say "Create new CLUSTER parameter group [$NEW_CLUSTER_PG] family [$FAMILY]…"
  aws rds create-db-cluster-parameter-group \
    --db-cluster-parameter-group-name "$NEW_CLUSTER_PG" \
    --db-parameter-group-family "$FAMILY" \
    --description "CDC Logical Replication (cluster-level)"
else
  say "CLUSTER parameter group [$NEW_CLUSTER_PG] already exists."
fi

# ========= CREATE / ENSURE INSTANCE PARAMETER GROUP =========
if ! aws rds describe-db-parameter-groups \
      --query "DBParameterGroups[?DBParameterGroupName=='$NEW_INSTANCE_PG']" \
      --output json | jq -e 'length>0' >/dev/null; then
  FAMILY_I=$(aws rds describe-db-parameter-groups \
    --db-parameter-group-name "$CUR_INSTANCE_PG" \
    --query "DBParameterGroups[0].DBParameterGroupFamily" \
    --output text)
  say "Create new INSTANCE parameter group [$NEW_INSTANCE_PG] family [$FAMILY_I]…"
  aws rds create-db-parameter-group \
    --db-parameter-group-name "$NEW_INSTANCE_PG" \
    --db-parameter-group-family "$FAMILY_I" \
    --description "CDC Logical Replication (instance-level)"
else
  say "INSTANCE parameter group [$NEW_INSTANCE_PG] already exists."
fi

# ========= SET CDC PARAMS (cluster-level) =========
say "Configure cluster-level params (max_wal_senders, max_replication_slots)…"
aws rds modify-db-cluster-parameter-group \
  --db-cluster-parameter-group-name "$NEW_CLUSTER_PG" \
  --parameters \
    "ParameterName=max_wal_senders,ParameterValue=${MAX_WAL_SENDERS},ApplyMethod=pending-reboot" \
    "ParameterName=max_replication_slots,ParameterValue=${MAX_REPL_SLOTS},ApplyMethod=pending-reboot" \
  >/dev/null

# ========= SET CDC PARAMS (instance-level: wal_level=logical) =========
say "Configure instance-level param wal_level=logical…"
aws rds modify-db-parameter-group \
  --db-parameter-group-name "$NEW_INSTANCE_PG" \
  --parameters "ParameterName=wal_level,ParameterValue=logical,ApplyMethod=pending-reboot" \
  >/dev/null

# ========= ATTACH PARAM GROUPS =========
say "Attach new CLUSTER parameter group to cluster [$CLUSTER_ID]…"
aws rds modify-db-cluster \
  --db-cluster-identifier "$CLUSTER_ID" \
  --db-cluster-parameter-group-name "$NEW_CLUSTER_PG" \
  --apply-immediately >/dev/null

say "Attach new INSTANCE parameter group to WRITER [$WRITER_INSTANCE_ID] and READER [$READER_INSTANCE_ID]…"
aws rds modify-db-instance \
  --db-instance-identifier "$WRITER_INSTANCE_ID" \
  --db-parameter-group-name "$NEW_INSTANCE_PG" \
  --apply-immediately >/dev/null

aws rds modify-db-instance \
  --db-instance-identifier "$READER_INSTANCE_ID" \
  --db-parameter-group-name "$NEW_INSTANCE_PG" \
  --apply-immediately >/dev/null

# ========= READER-FIRST REBOOT =========
say "Reboot READER first to activate pending instance params…"
aws rds reboot-db-instance --db-instance-identifier "$READER_INSTANCE_ID" >/dev/null

say "Validate reader after reboot (expect wal_level=logical)…"
cat <<EOF
Run on the READER psql:
  SHOW wal_level;
  SHOW max_wal_senders;
  SHOW max_replication_slots;
EOF

# ========= OPTIONAL FAILOVER =========
say "Optional: fail over so new writer has logical params active now…"
echo "aws rds failover-db-cluster --db-cluster-identifier $CLUSTER_ID"

say "After failover (or maintenance reboot of writer), validate on WRITER:
  SHOW wal_level;
  SHOW max_wal_senders;
  SHOW max_replication_slots;"

say "Done. CDC parameters staged cluster-wide, activated reader-first. ✅"
