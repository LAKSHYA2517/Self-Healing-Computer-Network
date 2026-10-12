"""All tunable constants."""
TICK_SECONDS = 1.0
PACKETS_PER_TICK = 100
K_DOWN = 2                    # consecutive down samples to declare a link down
K_DEGRADED = 3                # consecutive degraded samples to declare degraded
K_RECOVER = 5                 # consecutive good samples to declare healthy again
LOSS_DEGRADED_PCT = 5.0
LATENCY_DEGRADED_FACTOR = 2.5 # degraded if latency > factor * base latency
UTIL_CONGESTED_PCT = 85.0
HOLD_DOWN_TICKS = 10          # minimum ticks between route changes (failback only)
DEGRADED_PENALTY = 50.0
AVAILABLE_DELIVERY = 0.90     # a tick counts as "available" if delivery ratio >= this
EWMA_ALPHA = 0.3
SERIES_LEN = 120              # ticks of history kept for charts
